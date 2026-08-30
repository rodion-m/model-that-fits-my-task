import type { BenchmarkDefinition, BenchmarkObservation, SourceRecord, SourceResult } from "../types.js";
import { fetchText } from "../http.js";
import { alias } from "../identity.js";
import { evidence, numeric, reasoningSupport } from "../source-utils.js";
import { baseRecord, newRecordMap } from "./common.js";

const RAW_BASE = "https://raw.githubusercontent.com/LiveBench/new-livebench/main";
export const LIVEBENCH_SOURCE_URL = "https://github.com/LiveBench/new-livebench/tree/main/public";
export const LIVEBENCH_CONSTANTS_URL = `${RAW_BASE}/src/lib/constants.js`;
export const LIVEBENCH_MODEL_LINKS_URL = `${RAW_BASE}/src/Table/modelLinks.js`;

export async function collectLiveBench(options: { fetchImpl?: typeof fetch } = {}): Promise<SourceResult> {
  const fetchedAt = new Date().toISOString();
  const constants = await fetchText(LIVEBENCH_CONSTANTS_URL, { fetchImpl: options.fetchImpl, timeoutMs: 30_000, maxBytes: 128 * 1024 });
  const release = latestRelease(constants);
  if (!release) throw new Error("LiveBench constants omitted a release date");

  const urls = {
    table: `${RAW_BASE}/public/table_${release.replaceAll("-", "_")}.csv`,
    categories: `${RAW_BASE}/public/categories_${release.replaceAll("-", "_")}.json`,
    cost: `${RAW_BASE}/public/cost_${release.replaceAll("-", "_")}.csv`,
  };
  const [tableText, categoriesText, linksText] = await Promise.all([
    fetchText(urls.table, { fetchImpl: options.fetchImpl, timeoutMs: 30_000, maxBytes: 8 * 1024 * 1024 }),
    fetchText(urls.categories, { fetchImpl: options.fetchImpl, timeoutMs: 30_000, maxBytes: 128 * 1024 }),
    fetchText(LIVEBENCH_MODEL_LINKS_URL, { fetchImpl: options.fetchImpl, timeoutMs: 30_000, maxBytes: 512 * 1024 }),
  ]);
  let costText = "";
  let costWarning: string | undefined;
  try {
    costText = await fetchText(urls.cost, { fetchImpl: options.fetchImpl, timeoutMs: 30_000, maxBytes: 8 * 1024 * 1024 });
  } catch (error) {
    costWarning = `LiveBench cost file was unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
  const table = parseCsv(tableText);
  const categories = parseCategories(categoriesText);
  const links = parseModelLinks(linksText);
  if (table.rows.length === 0 || !table.headers.includes("model")) throw new Error("LiveBench table returned no model rows");
  if (Object.keys(categories).length === 0) throw new Error("LiveBench categories returned no categories");

  const costs = parseCostRows(costText);
  const definitions = benchmarkDefinitions(categories, release, urls.categories, fetchedAt);
  const records = table.rows.map((row) => buildRecord(row, categories, costs.get(row.model), links, release, urls.table, fetchedAt));
  return {
    source_id: "livebench",
    url: LIVEBENCH_SOURCE_URL,
    fetched_at: fetchedAt,
    status: "ok",
    replace_previous: true,
    records: [...newRecordMap(records).values()],
    benchmark_definitions: definitions,
    ...(costWarning ? { warnings: [costWarning] } : {}),
  };
}

export function latestRelease(constants: string): string | undefined {
  const releases = [...constants.matchAll(/"(\d{4}-\d{2}-\d{2})"/g)].map((match) => match[1]);
  return releases.sort().at(-1);
}

export function parseCsv(text: string): { headers: string[]; rows: Array<Record<string, string>> } {
  const matrix: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value !== "")) matrix.push(row);
      row = [];
      cell = "";
    } else cell += character;
  }
  row.push(cell);
  if (row.some((value) => value !== "")) matrix.push(row);
  const headers = matrix.shift() ?? [];
  return { headers, rows: matrix.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])) ) };
}

export function parseCategories(text: string): Record<string, string[]> {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(parsed).flatMap(([category, tasks]) =>
    Array.isArray(tasks) ? [[category, tasks.filter((task): task is string => typeof task === "string")]] : []));
}

export function parseModelLinks(text: string): Map<string, LiveBenchModelLink> {
  const links = new Map<string, LiveBenchModelLink>();
  const entryPattern = /^\s+"([^"\n]+)"\s*:\s*\{([\s\S]*?)(?=^\s+"[^"\n]+"\s*:\s*\{|^};)/gm;
  for (const match of text.matchAll(entryPattern)) {
    const rootId = match[1];
    const body = match[2];
    const info = {
      organization: property(body, "organization"),
      display_name: property(body, "displayName"),
      version: property(body, "version"),
      url: property(body, "url"),
      reasoner: booleanProperty(body, "reasoner"),
      openweight: booleanProperty(body, "openweight"),
    };
    const rawNames = [rootId, ...[...body.matchAll(/rawName:\s*"([^"]+)"/g)].map((value) => value[1])];
    const base = inferBaseId(rootId, info.display_name, rawNames);
    for (const rawName of rawNames) {
      const displayName = rawName === rootId ? info.display_name : variantDisplayName(body, rawName) ?? info.display_name;
      links.set(rawName, {
        ...info,
        base_id: base,
        effort: inferEffort(rawName, displayName),
        display_name: displayName,
      });
    }
  }
  return links;
}

interface LiveBenchModelLink {
  base_id: string;
  organization?: string;
  display_name?: string;
  version?: string;
  url?: string;
  reasoner?: boolean;
  openweight?: boolean;
  effort?: string;
}

function buildRecord(
  row: Record<string, string>,
  categories: Record<string, string[]>,
  cost: Record<string, string> | undefined,
  links: Map<string, LiveBenchModelLink>,
  release: string,
  tableUrl: string,
  fetchedAt: string,
): SourceRecord {
  const sourceModelId = row.model;
  const link = links.get(sourceModelId) ?? fallbackLink(sourceModelId);
  const baseId = link.base_id;
  const model = baseRecord({
    sourceId: "livebench",
    rawId: baseId,
    publisher: identityPublisher(link.organization),
    name: cleanDisplayName(link.display_name ?? sourceModelId),
    releaseDate: link.version,
    openWeights: link.openweight,
    fetchedAt,
    url: link.url ?? tableUrl,
    evidenceFields: ["benchmark", "evaluation_configuration", "metadata"],
  });
  model.aliases = [...(model.aliases ?? []), alias(sourceModelId, "livebench", "evaluation_model_id")];
  model.reasoning = [reasoningSupport(
    "livebench",
    { supported: link.reasoner ?? null, supported_efforts: link.effort ? [link.effort] : [] },
    fetchedAt,
    tableUrl,
  )];
  model.benchmarks = [];
  for (const [category, tasks] of Object.entries(categories)) {
    for (const task of tasks) {
      const value = numeric(row[task]);
      if (value === undefined) continue;
      model.benchmarks.push(observation(task, value, category, link, sourceModelId, release, cost, tableUrl, fetchedAt));
    }
    const categoryValue = mean(tasks.map((task) => numeric(row[task])).filter((value): value is number => value !== undefined));
    if (categoryValue !== undefined && tasks.every((task) => numeric(row[task]) !== undefined)) model.benchmarks.push(aggregateObservation(`category.${categorySlug(category)}`, categoryValue, category, link, sourceModelId, release, tasks.length, tableUrl, fetchedAt));
  }
  const categoryValues = Object.entries(categories).map(([category, tasks]) => mean(tasks.map((task) => numeric(row[task])).filter((value): value is number => value !== undefined)));
  const overall = mean(categoryValues.filter((value): value is number => value !== undefined));
  if (overall !== undefined && Object.values(categories).flat().every((task) => numeric(row[task]) !== undefined)) model.benchmarks.push(aggregateObservation("overall", overall, "Overall", link, sourceModelId, release, categoryValues.length, tableUrl, fetchedAt));
  if (cost) addCostMetrics(model, cost, categories, sourceModelId, release, tableUrl.replace("/table_", "/cost_"), fetchedAt);
  return model;
}

function observation(task: string, value: number, category: string, link: LiveBenchModelLink, sourceModelId: string, release: string, cost: Record<string, string> | undefined, url: string, fetchedAt: string): BenchmarkObservation {
  return {
    benchmark_id: `livebench.${slug(task)}`,
    value,
    metric: "score",
    unit: "percent",
    effort: link.effort,
    evaluator: "livebench",
    dataset_version: release,
    configuration: { score_direction: "higher_is_better" },
    metrics: {
      source_model_id: sourceModelId,
      category,
      ...(costMetric(cost, task) ?? {}),
    },
    evidence: evidence("livebench", url, fetchedAt, ["benchmark", "evaluation_configuration"]),
  };
}

function aggregateObservation(task: string, value: number, category: string, link: LiveBenchModelLink, sourceModelId: string, release: string, sampleCount: number, url: string, fetchedAt: string): BenchmarkObservation {
  return {
    benchmark_id: `livebench.${task}`,
    kind: task === "overall" ? "aggregate" : "index",
    value,
    metric: task === "overall" ? "overall_average" : "category_average",
    unit: "percent",
    effort: link.effort,
    evaluator: "livebench",
    dataset_version: release,
    configuration: { score_direction: "higher_is_better" },
    metrics: { source_model_id: sourceModelId, category, component_count: sampleCount },
    evidence: evidence("livebench", url, fetchedAt, ["benchmark", "derived_aggregate"], [], "Computed from the official LiveBench task table; not an independent task score."),
  };
}

function benchmarkDefinitions(categories: Record<string, string[]>, release: string, url: string, fetchedAt: string): BenchmarkDefinition[] {
  const definitions: BenchmarkDefinition[] = [];
  for (const [category, tasks] of Object.entries(categories)) {
    definitions.push({
      id: `livebench.category.${categorySlug(category)}`,
      kind: "index",
      name: category,
      category,
      version: release,
      updated_at: release,
      dataset_type: "objective",
      url: LIVEBENCH_SOURCE_URL,
      evidence: evidence("livebench", url, fetchedAt, ["benchmark_definition"]),
    });
    for (const task of tasks) definitions.push({
      id: `livebench.${slug(task)}`,
      kind: "benchmark",
      name: task.replaceAll("_", " "),
      category,
      version: release,
      updated_at: release,
      dataset_type: "objective",
      url: LIVEBENCH_SOURCE_URL,
      evidence: evidence("livebench", url, fetchedAt, ["benchmark_definition"]),
    });
  }
  definitions.push({ id: "livebench.overall", kind: "aggregate", name: "LiveBench overall", version: release, updated_at: release, dataset_type: "objective", url: LIVEBENCH_SOURCE_URL, evidence: evidence("livebench", url, fetchedAt, ["benchmark_definition"]) });
  return definitions;
}

function parseCostRows(text: string): Map<string, Record<string, string>> {
  if (!text) return new Map();
  const parsed = parseCsv(text);
  return new Map(parsed.rows.map((row) => [row.model, row]));
}

function addCostMetrics(model: SourceRecord, cost: Record<string, string>, categories: Record<string, string[]>, sourceModelId: string, release: string, url: string, fetchedAt: string): void {
  const rootMetrics: Record<string, number | string> = {
    source_model_id: sourceModelId,
    release,
  };
  for (const [key, raw] of Object.entries({
    cost_per_question_usd: cost.cost_per_question,
    cost_per_successful_task_usd: cost.cost_per_successful_task,
    avg_input_tokens: cost.avg_input_tokens,
    avg_output_tokens: cost.avg_output_tokens,
    input_price_per_million: cost.input_price_per_million,
    output_price_per_million: cost.output_price_per_million,
  })) {
    const value = numeric(raw);
    if (value !== undefined) rootMetrics[key] = value;
  }
  model.evidence = [...(model.evidence ?? []), evidence("livebench", url, fetchedAt, ["cost", "tokens", "evaluation_configuration"], [], "Evaluation-run economics from the official LiveBench cost file; not a provider route quote.")];
  for (const observation of model.benchmarks ?? []) {
    const overall = observation.benchmark_id === "livebench.overall";
    const tasks = overall ? Object.values(categories).flat()
      : observation.benchmark_id.startsWith("livebench.category.") ? categories[String(observation.metrics?.category)] ?? []
      : Object.values(categories).flat().filter((task) => `livebench.${slug(task)}` === observation.benchmark_id);
    const metrics: Record<string, number | string> = overall ? { ...rootMetrics } : { source_model_id: sourceModelId, release };
    const rows = tasks.map((task) => ({ total: numeric(cost[task]), questions: numeric(cost[`nq_${task}`]), output: numeric(cost[`out_${task}`]) }));
    if (rows.length > 0 && rows.every((row) => row.total !== undefined && row.questions !== undefined && row.questions > 0)) {
      const total = rows.reduce((sum, row) => sum + row.total!, 0);
      const questions = rows.reduce((sum, row) => sum + row.questions!, 0);
      metrics.evaluation_cost_usd = total;
      metrics.question_count = questions;
      metrics.cost_per_question_usd = total / questions;
      if (observation.value > 0) metrics.cost_per_successful_task_usd = total / questions / (observation.value / 100);
      if (!overall && rows.every((row) => row.output !== undefined)) metrics.avg_output_tokens = rows.reduce((sum, row) => sum + row.output! * row.questions!, 0) / questions;
      if (Number.isSafeInteger(questions)) observation.sample_count = questions;
    }
    observation.metrics = { ...(observation.metrics ?? {}), ...metrics };
  }
}

function costMetric(cost: Record<string, string> | undefined, task: string): Record<string, number> | undefined {
  if (!cost) return undefined;
  const total = numeric(cost[task]);
  const questions = numeric(cost[`nq_${task}`]);
  if (total === undefined && questions === undefined) return undefined;
  return {
    ...(total !== undefined ? { evaluation_cost_usd: total } : {}),
    ...(questions !== undefined ? { question_count: questions } : {}),
    ...(total !== undefined && questions ? { cost_per_question_usd: total / questions } : {}),
  };
}

function fallbackLink(sourceModelId: string): LiveBenchModelLink {
  const lower = sourceModelId.toLowerCase();
  const organization = lower.startsWith("claude-") ? "Anthropic"
    : lower.startsWith("gemini-") ? "Google"
      : lower.startsWith("glm-") ? "Z.AI"
        : lower.startsWith("gpt-") ? "OpenAI"
          : lower.startsWith("grok-") ? "xAI"
            : lower.startsWith("kimi-") ? "Moonshot AI"
              : lower.startsWith("qwen") ? "Alibaba"
                : lower.startsWith("deepseek-") ? "DeepSeek"
                  : undefined;
  return { base_id: removeEffortSuffix(sourceModelId, sourceModelId), organization, effort: inferEffort(sourceModelId, sourceModelId) };
}

function inferBaseId(rootId: string, displayName: string | undefined, rawNames: string[]): string {
  if (rawNames.length < 2) return removeEffortSuffix(rootId, displayName);
  const bases = rawNames.map((rawName) => removeEffortSuffix(rawName, displayName));
  const common = longestCommonPrefix(bases);
  return common.replace(/[-_.]+$/, "") || removeEffortSuffix(rootId, displayName);
}

function inferEffort(rawName: string, displayName?: string): string | undefined {
  const value = `${rawName} ${displayName ?? ""}`.toLowerCase();
  if (/xhigh/.test(value) || /(?:^|-)xhigh(?:-effort)?$/.test(rawName.toLowerCase())) return "xhigh";
  if (/max(?:-effort|\s+effort)/.test(value)) return "max";
  if (/high(?:-effort|\s+effort)/.test(value) || /(?:^|-)high$/.test(rawName.toLowerCase())) return "high";
  if (/medium(?:-effort|\s+effort)/.test(value) || /(?:^|-)medium$/.test(rawName.toLowerCase())) return "medium";
  if (/low(?:-effort|\s+effort)/.test(value) || /(?:^|-)low$/.test(rawName.toLowerCase())) return "low";
  return undefined;
}

function removeEffortSuffix(value: string, displayName?: string): string {
  const effort = inferEffort(value, displayName);
  if (!effort) return value;
  return value
    .replace(new RegExp(`(?:-${effort}(?:-effort)?|-${effort}effort)$`, "i"), "")
    .replace(/-thinking(?:-(?:auto|\d+[km]))?$/i, "");
}

function variantDisplayName(body: string, rawName: string): string | undefined {
  const escaped = rawName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return body.match(new RegExp(`rawName:\\s*"${escaped}"\\s*,\\s*displayName:\\s*"([^"]+)"`))?.[1];
}

function property(body: string, key: string): string | undefined {
  return body.match(new RegExp(`${key}:\\s*"([^"]+)"`))?.[1];
}

function booleanProperty(body: string, key: string): boolean | undefined {
  const value = body.match(new RegExp(`${key}:\\s*(true|false)`))?.[1];
  return value === undefined ? undefined : value === "true";
}

function cleanDisplayName(value: string): string {
  return value.replace(/\s+(?:thinking\s+)?(?:low|medium|high|xhigh|max)(?:\s+effort)?$/i, "").replace(/\s+thinking$/i, "").trim();
}

function identityPublisher(value: string | undefined): string | undefined {
  if (value === "xAI") return "x-ai";
  if (value === "Moonshot AI") return "moonshotai";
  if (value === "Abacus.AI") return "abacusai";
  return value;
}

function mean(values: number[]): number | undefined {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function categorySlug(value: string): string {
  return value.toLowerCase() === "if" ? "instruction_following" : slug(value);
}

function longestCommonPrefix(values: string[]): string {
  if (values.length === 0) return "";
  let prefix = values[0];
  for (const value of values.slice(1)) while (!value.startsWith(prefix)) prefix = prefix.slice(0, -1);
  return prefix;
}
