import type { BenchmarkDefinition, BenchmarkObservation, Model, Snapshot, SourceRecord, SourceResult } from "../types.js";
import { fetchText, mapWithConcurrency } from "../http.js";
import { alias, unresolvedModelId } from "../identity.js";
import { evidence, numeric, record, stringValue } from "../source-utils.js";
import { asRecord } from "../utils.js";
import { baseRecord, mergeSourceRecord, newRecordMap } from "./common.js";

export const VALS_BENCHMARKS_URL = "https://www.vals.ai/benchmarks";

interface ValsBenchmarkView {
  metadata: Record<string, unknown>;
  tasks: Record<string, Record<string, Record<string, unknown>>>;
}

interface ValsPage {
  slug: string;
  url: string;
  view: ValsBenchmarkView;
}

export async function collectVals(options: {
  fetchImpl?: typeof fetch;
  previous?: Snapshot;
  benchmarkLimit?: number;
} = {}): Promise<SourceResult> {
  const fetchedAt = new Date().toISOString();
  const catalogHtml = await fetchText(VALS_BENCHMARKS_URL, {
    fetchImpl: options.fetchImpl,
    timeoutMs: 30_000,
    maxBytes: 4 * 1024 * 1024,
  });
  const discovered = parseValsCatalog(catalogHtml);
  const slugs = options.benchmarkLimit === undefined ? discovered : discovered.slice(0, options.benchmarkLimit);
  const pages = await mapWithConcurrency(slugs, 4, async (slug) => {
    const url = `${VALS_BENCHMARKS_URL}/${encodeURIComponent(slug)}`;
    try {
      const html = await fetchText(url, { fetchImpl: options.fetchImpl, timeoutMs: 30_000, maxBytes: 6 * 1024 * 1024 });
      try {
        return { slug, url, view: parseValsBenchmarkPage(html) };
      } catch (error) {
        const componentPath = rsiComponentPath(html);
        if (!componentPath) throw error;
        const bundle = await fetchText(new URL(componentPath, url).toString(), {
          fetchImpl: options.fetchImpl,
          timeoutMs: 30_000,
          maxBytes: 2 * 1024 * 1024,
        });
        return { slug, url, view: parseValsRsiBundle(bundle, html) };
      }
    } catch (error) {
      return { slug, url, error: error instanceof Error ? error.message : String(error) };
    }
  });
  const successful = pages.filter((page): page is ValsPage => "view" in page);
  const failed = pages.flatMap((page) => "error" in page ? [`${page.slug}: ${page.error}`] : []);
  if (failed.length > 0) throw new Error(`Vals collection is incomplete: ${failed.join("; ")}`);
  if (successful.length === 0) throw new Error("Vals benchmark pages returned no parseable results");

  const records = new Map<string, SourceRecord>();
  const definitions: BenchmarkDefinition[] = [];
  const existingIds = existingModels(options.previous);
  for (const { url, view } of successful) {
    const metadata = record(view.metadata);
    const slug = stringValue(metadata.slug ?? metadata.benchmark_id);
    if (!slug) continue;
    const rawBenchmarkId = `vals.${slug}`;
    definitions.push({
      id: rawBenchmarkId,
      ...(stringValue(metadata.benchmark) ? { name: stringValue(metadata.benchmark) } : {}),
      ...(stringValue(metadata.industry) ? { category: stringValue(metadata.industry) } : {}),
      ...(stringValue(metadata.description) ? { description: stringValue(metadata.description)!.slice(0, 300) } : {}),
      ...(stringValue(metadata.updated)?.slice(0, 4).match(/^\d{4}$/) ? { year: Number(stringValue(metadata.updated)!.slice(0, 4)) } : {}),
      ...(stringValue(metadata.version) ? { version: stringValue(metadata.version) } : {}),
      ...(stringValue(metadata.updated) ? { updated_at: stringValue(metadata.updated) } : {}),
      ...(stringValue(metadata.dataset_type) ? { dataset_type: stringValue(metadata.dataset_type) } : {}),
      url,
      evidence: evidence("vals", url, fetchedAt, ["benchmark_definition"]),
    });

    for (const [task, rawResults] of Object.entries(view.tasks)) {
      for (const [rawModelId, rawResult] of Object.entries(asRecord(rawResults))) {
        const result = record(rawResult);
        const value = numeric(result.value ?? result.accuracy);
        if (value === undefined) continue;
        const score = valsScore(metadata, task, result);
        const derivedFrom = result.derived === true ? ["vals:rsi_task_scores"] : [];
        const sourceEvidence = evidence("vals", url, fetchedAt, observationFields(result), derivedFrom, "Public Vals leaderboard snapshot embedded in static Astro HTML.");
        const metrics = compactMetrics(result);
        const configuration = compactConfiguration(result);
        const observation: BenchmarkObservation = {
          benchmark_id: rawBenchmarkId,
          value,
          unit: stringValue(result.unit) ?? score.unit,
          metric: stringValue(result.metric) ?? score.metric,
          ...(task !== "overall" ? { variant: task } : {}),
          ...(stringValue(result.reasoning_effort ?? result.compute_effort) ? { effort: stringValue(result.reasoning_effort ?? result.compute_effort) } : {}),
          evaluator: "vals",
          ...(stringValue(metadata.version) ? { dataset_version: stringValue(metadata.version) } : {}),
          ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
          ...(Object.keys(configuration).length > 0 ? { configuration } : {}),
          evidence: sourceEvidence,
        };
        const existing = existingIds.get(rawModelId.toLowerCase());
        const normalized: SourceRecord = existing
          ? {
              id: existing.id,
              identity_confidence: rawModelId.toLowerCase() === existing.id.toLowerCase() ? "exact" : "alias",
              aliases: [alias(rawModelId, "vals")],
              benchmarks: [observation],
              evidence: [sourceEvidence],
            }
          : unmatchedValsRecord(rawModelId, observation, sourceEvidence, fetchedAt, url);
        records.set(normalized.id, records.has(normalized.id)
          ? mergeSourceRecord(records.get(normalized.id)!, normalized)
          : normalized);
      }
    }
  }
  return {
    source_id: "vals",
    url: VALS_BENCHMARKS_URL,
    fetched_at: fetchedAt,
    status: "ok",
    records: [...newRecordMap([...records.values()]).values()],
    benchmark_definitions: definitions,
    warnings: pages.flatMap((page) => "error" in page ? [`${page.slug}: ${page.error}`] : []),
    replace_previous: slugs.length === discovered.length,
  };
}

export function parseValsCatalog(html: string): string[] {
  const slugs = [...html.matchAll(/href=["']\/benchmarks\/([^"'?#]+)["']/g)].map((match) => decodeURIComponent(match[1]));
  const unique = [...new Set(slugs)].filter((slug) => /^[a-z0-9][a-z0-9_-]*$/i.test(slug));
  if (unique.length === 0) throw new Error("Vals benchmark catalog contained no benchmark links");
  return unique;
}

export function parseValsBenchmarkPage(html: string): ValsBenchmarkView {
  const candidates: ValsBenchmarkView[] = [];
  for (const match of html.matchAll(/<astro-island\b[^>]*>/g)) {
    const tag = match[0];
    const props = attribute(tag, "props");
    if (!props) continue;
    try {
      const decoded = decodeAstro(JSON.parse(decodeHtmlAttribute(props))) as Record<string, unknown>;
      const direct = decoded.benchmarkView;
      const nested = asRecord(decoded.benchmarkView).default;
      for (const value of [direct, nested]) {
        const candidate = asRecord(value);
        if (stringValue(asRecord(candidate.metadata).slug) && Object.keys(asRecord(candidate.tasks)).length > 0) {
          candidates.push(candidate as unknown as ValsBenchmarkView);
        }
      }
    } catch {
      // Other islands may contain unrelated or newly encoded props.
    }
  }
  const detailed = candidates.sort((a, b) => Object.keys(b.tasks).length - Object.keys(a.tasks).length)[0];
  if (!detailed) throw new Error("Vals page contained no structured benchmark view");
  return detailed;
}

export function parseValsRsiBundle(bundle: string, html = ""): ValsBenchmarkView {
  const aggregate = assignmentObject(bundle, variableForProperty(bundle, "capability"));
  const taskRows = assignmentArray(bundle, variableForProperty(bundle, "tasks"));
  const profiles = objectContaining(bundle, "headline");
  const tasks: ValsBenchmarkView["tasks"] = { overall: {} };

  for (const [modelId, rawScores] of Object.entries(aggregate)) {
    const scores = record(rawScores);
    const values = Object.values(scores).map(numeric).filter((value): value is number => value !== undefined);
    if (values.length === 0) continue;
    const profile = record(profiles[modelId]);
    tasks.overall[modelId] = {
      value: values.reduce((sum, value) => sum + value, 0) / values.length,
      metric: "normalized_score",
      unit: "fraction",
      derived: true,
      reasoning_effort: stringValue(profile.effort),
      harness: stringValue(profile.harness),
    };
  }

  for (const rawTask of taskRows) {
    const task = record(rawTask);
    const taskId = stringValue(task.key);
    if (!taskId) continue;
    tasks[taskId] = {};
    for (const [modelId, rawResult] of Object.entries(record(task.models))) {
      const result = record(rawResult);
      const score = numeric(result.score);
      if (score === undefined) continue;
      const profile = record(profiles[modelId]);
      tasks[taskId][modelId] = {
        value: score,
        metric: "normalized_score",
        unit: "fraction",
        api_cost_usd: numeric(result.api_cost_usd),
        experiments: numeric(result.experiments),
        result: stringValue(result.result),
        tokens: stringValue(result.tokens),
        status: stringValue(result.status),
        reasoning_effort: stringValue(profile.effort),
        harness: stringValue(profile.harness),
      };
    }
  }

  if (Object.keys(tasks.overall).length === 0) throw new Error("Vals RSI bundle contained no model scores");
  return {
    metadata: {
      benchmark: "RSI Index",
      slug: "rsi_index",
      updated: valsDate(html.match(/Updated\s+(\d{1,2}\/\d{1,2}\/\d{4})/)?.[1]),
      industry: "research",
      description: decodeHtmlAttribute(html.match(/name="description"\s+content="([^"]+)"/)?.[1] ?? "Autonomous AI research across tasks relevant to recursive self-improvement."),
    },
    tasks,
  };
}

function existingModels(snapshot: Snapshot | undefined): Map<string, Model> {
  const values = new Map<string, Model | undefined>();
  for (const model of snapshot?.models ?? []) {
    if (model.offers.length === 0 && model.evidence.length > 0 && model.evidence.every((item) => item.source_id === "vals")) continue;
    values.set(model.id.toLowerCase(), model);
    for (const alias of model.aliases) {
      const key = alias.id.toLowerCase();
      values.set(key, values.has(key) && values.get(key)?.id !== model.id ? undefined : model);
    }
    for (const currentOffer of model.offers) {
      const key = currentOffer.provider_model_id.toLowerCase();
      values.set(key, values.has(key) && values.get(key)?.id !== model.id ? undefined : model);
    }
  }
  return new Map([...values.entries()].filter((entry): entry is [string, Model] => Boolean(entry[1])));
}

function unmatchedValsRecord(rawModelId: string, observation: BenchmarkObservation, sourceEvidence: BenchmarkObservation["evidence"], fetchedAt: string, url: string): SourceRecord {
  const normalized = baseRecord({
    sourceId: "vals",
    rawId: rawModelId,
    publisher: rawModelId.split("/")[0],
    name: rawModelId.split("/").at(-1),
    fetchedAt,
    url,
    evidenceFields: sourceEvidence.fields ?? ["benchmarks"],
  });
  normalized.id = unresolvedModelId("vals", rawModelId);
  normalized.identity_confidence = "unresolved";
  normalized.aliases = [alias(rawModelId, "vals"), alias(normalized.id, "vals", "canonical_id")];
  normalized.benchmarks = [observation];
  normalized.evidence = [sourceEvidence];
  return normalized;
}

function valsScore(metadata: Record<string, unknown>, task: string, result: Record<string, unknown>): { metric: string; unit: string } {
  const slug = stringValue(metadata.slug ?? metadata.benchmark_id) ?? "unknown";
  const label = stringValue(metadata.accuracy_label);
  if (slug === "voice-code-bench") {
    const metrics: Record<string, string> = { overall: "task_success_rate", ctem: "canonical_token_entity_match", wer: "wer" };
    if (metrics[task]) return { metric: metrics[task], unit: "percent" };
  }
  if (slug === "programbench") {
    if (task === "partial") return { metric: "raw_pass_rate", unit: "percent" };
    if (task === "almost") return { metric: "almost_resolved_rate", unit: "percent" };
    return { metric: "fully_resolved_rate", unit: "percent" };
  }
  if (slug === "reverse_eng") return { metric: task === "partial" ? "capability_score" : "fully_solved_rate", unit: "percent" };
  if (slug === "hlab" || stringValue(metadata.benchmark_id) === "legal_agent_benchmark") {
    return { metric: task.startsWith("criteria_pass_rate") ? "criteria_pass_rate" : "task_resolution_rate", unit: "percent" };
  }
  if (slug === "time_horizon_index") return { metric: "mission_progress", unit: "percent" };
  if (task === "all_pass") return { metric: "all_pass_rate", unit: "percent" };
  if (task.startsWith("weighted_pass")) return { metric: "weighted_pass_rate", unit: "percent" };
  if (task.includes("pass_rate")) return { metric: "pass_rate", unit: "percent" };
  if (label) return { metric: metricName(label), unit: slug === "poker_agent" ? "rating" : label.includes("%") ? "percent" : "score" };
  if (String(metadata.industry).toLowerCase() === "index") return { metric: "index_score", unit: "percent" };
  return { metric: result.accuracy !== undefined ? "score" : "value", unit: "percent" };
}

function metricName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function observationFields(result: Record<string, unknown>): string[] {
  const fields = ["benchmarks"];
  if (numeric(result.latency) !== undefined) fields.push("runtime");
  if (numeric(result.cost_per_test ?? result.api_cost_usd) !== undefined) fields.push("cost");
  if (Object.keys(compactConfiguration(result)).length > 0) fields.push("evaluation_configuration");
  return fields;
}

function compactMetrics(result: Record<string, unknown>): Record<string, number | string | boolean | null> {
  const output: Record<string, number | string | boolean | null> = {};
  for (const key of ["latency", "stderr", "cost_per_test", "avg_input_tokens", "avg_output_tokens", "api_cost_usd", "experiments", "result", "tokens", "status", "tie_breaker_score"]) {
    const value = result[key];
    if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") output[key] = value;
  }
  return output;
}

function compactConfiguration(result: Record<string, unknown>): Record<string, number | string | boolean | null> {
  const output: Record<string, number | string | boolean | null> = {};
  for (const key of ["temperature", "top_p", "max_output_tokens", "reasoning", "reasoning_effort", "verbosity", "compute_effort", "provider", "harness"]) {
    const value = result[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") output[key] = value;
  }
  return output;
}

function attribute(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
}

function rsiComponentPath(html: string): string | undefined {
  return html.match(/component-url="([^"]*\/RsiBenchmarkView\.[^"]+\.js)"/)?.[1];
}

function variableForProperty(bundle: string, property: string): string {
  const match = bundle.match(new RegExp(`\\b${property}:([A-Za-z_$][\\w$]*)`));
  if (!match) throw new Error(`Vals RSI bundle omitted ${property}`);
  return match[1];
}

function assignmentObject(bundle: string, variable: string): Record<string, unknown> {
  const value = assignmentLiteral(bundle, variable);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Vals RSI ${variable} was not an object`);
  return value as Record<string, unknown>;
}

function objectContaining(bundle: string, property: string): Record<string, unknown> {
  for (const match of bundle.matchAll(/(?:const|,)\s*([A-Za-z_$][\w$]*)=\{/g)) {
    try {
      const candidate = assignmentObject(bundle, match[1]);
      if (Object.values(candidate).some((value) => Object.hasOwn(record(value), property))) return candidate;
    } catch {
      // Function bodies and computed expressions are not data literals.
    }
  }
  throw new Error(`Vals RSI bundle omitted ${property} profiles`);
}

function assignmentArray(bundle: string, variable: string): unknown[] {
  const value = assignmentLiteral(bundle, variable);
  if (!Array.isArray(value)) throw new Error(`Vals RSI ${variable} was not an array`);
  return value;
}

function assignmentLiteral(bundle: string, variable: string): unknown {
  const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:const|,)\\s*${escaped}=`).exec(bundle);
  if (!match) throw new Error(`Vals RSI bundle omitted ${variable}`);
  const start = match.index + match[0].length;
  const literal = balancedLiteral(bundle, start);
  const json = literal
    .replace(/([,{])([A-Za-z_$][\w$]*):/g, '$1"$2":')
    .replace(/(^|[:,\[])\.(\d+)/g, (_match, prefix: string, digits: string) => `${prefix}0.${digits}`)
    .replace(/(^|[:,\[])-\.(\d+)/g, (_match, prefix: string, digits: string) => `${prefix}-0.${digits}`);
  try {
    return JSON.parse(json);
  } catch {
    throw new Error(`Vals RSI ${variable} was not a supported data literal`);
  }
}

function balancedLiteral(source: string, start: number): string {
  const opener = source[start];
  const closer = opener === "{" ? "}" : opener === "[" ? "]" : undefined;
  if (!closer) throw new Error("Vals RSI assignment was not an object or array literal");
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === opener) depth += 1;
    else if (character === closer && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error("Vals RSI data literal was truncated");
}

function decodeHtmlAttribute(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|quot|apos|amp|lt|gt);/gi, (entity, code: string) => {
    if (code[0] === "#") return String.fromCodePoint(Number.parseInt(code[1].toLowerCase() === "x" ? code.slice(2) : code.slice(1), code[1].toLowerCase() === "x" ? 16 : 10));
    return ({ quot: '"', apos: "'", amp: "&", lt: "<", gt: ">" } as Record<string, string>)[code.toLowerCase()] ?? entity;
  });
}

function valsDate(value: string | undefined): string | undefined {
  const match = value?.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return value;
  return `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
}

function decodeAstro(value: unknown): unknown {
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === "number") {
    const [type, payload] = value;
    if (type === 0) return payload && typeof payload === "object" ? Object.fromEntries(Object.entries(payload).map(([key, child]) => [key, decodeAstro(child)])) : payload;
    if (type === 1) return Array.isArray(payload) ? payload.map(decodeAstro) : [];
    if (type === 2) return String(payload);
    if (type === 3) return String(payload);
    if (type === 6) return String(payload);
    return payload;
  }
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, decodeAstro(child)]));
  return value;
}
