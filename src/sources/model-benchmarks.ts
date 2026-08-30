import type { BenchmarkDefinition, BenchmarkObservation, SourceRecord, SourceResult } from "../types.js";
import { fetchJson, fetchText, mapWithConcurrency } from "../http.js";
import { alias } from "../identity.js";
import { evidence, numeric, reasoningSupport, stringValue } from "../source-utils.js";
import { asArray, asRecord, slugify } from "../utils.js";
import { baseRecord, newRecordMap } from "./common.js";

export const ARENA_DATASET_URL = "https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset";
export const ARENA_ROWS_URL = "https://datasets-server.huggingface.co/rows";
export const ARENA_LEADERBOARD_URL = "https://arena.ai/leaderboard";

// Agent Arena is deliberately excluded: it measures an agent plus a model and
// its harness, while these records are intended to be model-level evidence.
export const ARENA_MODEL_CONFIGS = [
  "text",
  "text_factuality",
  "text_style_control",
  "vision",
  "vision_style_control",
  "search",
  "search_factuality",
  "search_style_control",
  "document",
  "document_style_control",
  "webdev",
  "image_edit",
  "text_to_image",
  "text_to_video",
  "image_to_video",
  "video_edit",
] as const;

export const FORECASTBENCH_BASELINE_URL = "https://raw.githubusercontent.com/forecastingresearch/forecastbench/main/src/www.forecastbench.org/assets/js/leaderboard_baseline_full.js";
export const FORECASTBENCH_PAGE_URL = "https://forecastbench.org/leaderboards/";

type Scalar = number | string | boolean | null;

interface ArenaPage {
  config: string;
  url: string;
  rows: Record<string, unknown>[];
}

interface ArenaRow {
  model_name: string;
  organization?: string;
  license?: string;
  rating?: number;
  rating_lower?: number;
  rating_upper?: number;
  variance?: number;
  vote_count?: number;
  rank?: number;
  category?: string;
  leaderboard_publish_date?: string;
}

interface ForecastRow {
  Model?: string;
  "Model Organization"?: string;
  Dataset?: number;
  "N dataset"?: number;
  "Dataset 95% CI"?: string;
  Market?: number;
  "N market"?: number;
  "Market 95% CI"?: string;
  Overall?: number;
  N?: number;
  "Overall 95% CI"?: string;
}

interface ModelVariant {
  baseName: string;
  variant?: string;
  effort?: string;
}

export async function collectArena(options: { fetchImpl?: typeof fetch } = {}): Promise<SourceResult> {
  const fetchedAt = new Date().toISOString();
  const pages = await mapWithConcurrency([...ARENA_MODEL_CONFIGS], 4, (config) => fetchArenaConfig(config, options.fetchImpl));
  const records = pages.flatMap((page) => page.rows
    .map((row) => arenaRecord(row as unknown as ArenaRow, page.config, page.url, fetchedAt))
    .filter((record): record is SourceRecord => Boolean(record)));
  if (records.length === 0) throw new Error("Arena latest dataset returned no model rows");

  const dates = records.flatMap((record) => record.benchmarks ?? [])
    .map((observation) => observation.metrics?.leaderboard_publish_date)
    .filter((value): value is string => typeof value === "string")
    .sort();
  const updatedAt = dates.at(-1);
  const definitions = ARENA_MODEL_CONFIGS.map((config) => arenaDefinition(config, fetchedAt, updatedAt));
  return {
    source_id: "arena",
    url: ARENA_DATASET_URL,
    fetched_at: fetchedAt,
    status: "ok",
    replace_previous: true,
    records: [...newRecordMap(records).values()],
    benchmark_definitions: definitions,
  };
}

export async function collectForecastBench(options: { fetchImpl?: typeof fetch } = {}): Promise<SourceResult> {
  const fetchedAt = new Date().toISOString();
  const script = await fetchText(FORECASTBENCH_BASELINE_URL, {
    fetchImpl: options.fetchImpl,
    timeoutMs: 30_000,
    maxBytes: 8 * 1024 * 1024,
  });
  const rows = parseForecastBenchRows(script);
  const records = rows.flatMap((row) => forecastRecord(row, fetchedAt));
  if (records.length === 0) throw new Error("ForecastBench baseline leaderboard returned no model rows");
  return {
    source_id: "forecastbench",
    url: FORECASTBENCH_PAGE_URL,
    fetched_at: fetchedAt,
    status: "ok",
    replace_previous: true,
    records: [...newRecordMap(records).values()],
    benchmark_definitions: forecastDefinitions(fetchedAt),
  };
}

export function parseForecastBenchRows(script: string): ForecastRow[] {
  const literal = extractAssignedArray(script, "data");
  const parsed = new LiteralParser(literal).parse();
  if (!Array.isArray(parsed)) throw new Error("ForecastBench data assignment was not an array");
  const rows = parsed.map((value) => asRecord(value) as ForecastRow);
  if (rows.length === 0) throw new Error("ForecastBench data assignment was empty");
  return rows;
}

async function fetchArenaConfig(config: string, fetchImpl?: typeof fetch): Promise<ArenaPage> {
  const rows: Record<string, unknown>[] = [];
  const pageSize = 100;
  let offset = 0;
  let firstUrl = ARENA_ROWS_URL;
  let reachedEnd = false;
  for (let page = 0; page < 20; page += 1) {
    const url = new URL(ARENA_ROWS_URL);
    url.searchParams.set("dataset", "lmarena-ai/leaderboard-dataset");
    url.searchParams.set("config", config);
    url.searchParams.set("split", "latest");
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("length", String(pageSize));
    if (page === 0) firstUrl = url.toString();
    const payload = await fetchJson<any>(url.toString(), {
      fetchImpl,
      timeoutMs: 30_000,
      maxBytes: 512 * 1024,
      retries: 2,
    });
    const pageRows = asArray(payload?.rows).map((value) => asRecord(asRecord(value).row));
    if (pageRows.length === 0) {
      reachedEnd = true;
      break;
    }
    const overallRows = pageRows.filter((row) => stringValue(row.category)?.toLowerCase() === "overall");
    rows.push(...overallRows);
    offset += pageRows.length;
    // Hugging Face orders the latest split by category. Continue through a
    // mixed page, then stop at the first page with no overall rows.
    if (overallRows.length === 0 || pageRows.length < pageSize) {
      reachedEnd = true;
      break;
    }
  }
  if (!reachedEnd) throw new Error(`Arena ${config} pagination exceeded the safety cap`);
  if (rows.length === 0) throw new Error(`Arena ${config} latest split returned no overall model rows`);
  return { config, url: firstUrl, rows };
}

function arenaRecord(row: ArenaRow, config: string, url: string, fetchedAt: string): SourceRecord | undefined {
  const modelName = stringValue(row.model_name);
  const rating = numeric(row.rating);
  if (!modelName || rating === undefined) return undefined;
  const variant = parseModelVariant(modelName);
  const organization = stringValue(row.organization);
  const canonicalId = arenaCanonicalId(variant.baseName, organization);
  const sourceEvidence = evidence(
    "arena",
    url,
    fetchedAt,
    ["benchmark", "evaluation_configuration", "metadata"],
    [],
    "Latest Arena human-preference rating; this is a preference signal, not objective task accuracy.",
  );
  const normalized = baseRecord({
    sourceId: "arena",
    rawId: canonicalId,
    publisher: organization,
    name: variant.baseName,
    license: row.license,
    fetchedAt,
    url: ARENA_LEADERBOARD_URL,
    evidenceFields: ["benchmark", "evaluation_configuration", "metadata"],
  });
  normalized.aliases = [
    ...(normalized.aliases ?? []),
    alias(modelName, "arena", "evaluation_model_name"),
  ];
  normalized.reasoning = variant.effort
    ? [reasoningSupport("arena", { supported: true, supported_efforts: [variant.effort] }, fetchedAt, url)]
    : [];
  normalized.benchmarks = [{
    benchmark_id: `arena.${config}`,
    kind: "index",
    value: rating,
    metric: "elo",
    unit: "rating",
    ...(variant.variant ? { variant: variant.variant } : {}),
    ...(variant.effort ? { effort: variant.effort } : {}),
    evaluator: "arena",
    dataset_version: "latest",
    ...(numeric(row.vote_count) !== undefined ? { sample_count: Math.round(numeric(row.vote_count)!) } : {}),
    metrics: compactArenaMetrics(row),
    configuration: {
      split: "latest",
      category: stringValue(row.category) ?? "overall",
      preference_method: "blind_pairwise_human_preference",
      ...(config.endsWith("_style_control") ? { style_control: true } : {}),
    },
    evidence: sourceEvidence,
  }];
  normalized.evidence = [sourceEvidence];
  return normalized;
}

function arenaDefinition(config: string, fetchedAt: string, updatedAt: string | undefined): BenchmarkDefinition {
  return {
    id: `arena.${config}`,
    kind: "index",
    name: `Arena ${humanize(config)}`,
    category: "human_preference",
    description: "Blind pairwise human-preference rating from the latest Arena snapshot. It is useful for perceived response quality, but is not an objective task-accuracy benchmark.",
    version: "latest",
    ...(updatedAt ? { updated_at: updatedAt } : {}),
    dataset_type: "human_preference",
    url: ARENA_DATASET_URL,
    evidence: evidence("arena", ARENA_DATASET_URL, fetchedAt, ["benchmark_definition", "evaluation_configuration"]),
  };
}

function compactArenaMetrics(row: ArenaRow): Record<string, Scalar> {
  const metrics: Record<string, Scalar> = {};
  for (const [key, value] of Object.entries({
    rating_lower: numeric(row.rating_lower),
    rating_upper: numeric(row.rating_upper),
    variance: numeric(row.variance),
    vote_count: numeric(row.vote_count),
    rank: numeric(row.rank),
    organization: stringValue(row.organization),
    leaderboard_publish_date: stringValue(row.leaderboard_publish_date),
  })) {
    if (value !== undefined) metrics[key] = value;
  }
  return metrics;
}

function parseModelVariant(value: string): ModelVariant {
  let baseName = value.replace(/[†*]/g, "").replace(/\s+/g, " ").trim();
  let effort: string | undefined;
  // Max is a product tier for Qwen, Flux and other families. Bare effort
  // suffixes are recognized only for families that publish that convention.
  const hasBareEffortConvention = /^(?:openai\/|anthropic\/|x-ai\/|google\/|z-ai\/|moonshotai\/)?(?:gpt-|o[134](?:-|$)|claude-|grok-|gemini-|glm-|kimi-)/i.test(baseName)
    && !/-codex-max$/i.test(baseName);
  const effortMatch = baseName.match(/\s*\((low|medium|high|xhigh|max)\)\s*$/i)
    ?? (hasBareEffortConvention ? baseName.match(/[-_](low|medium|high|xhigh|max)$/i) : null);
  if (effortMatch) {
    effort = effortMatch[1].toLowerCase();
    baseName = baseName.slice(0, effortMatch.index ?? baseName.length).trim();
  }
  return { baseName, effort };
}

function arenaCanonicalId(modelName: string, organization: string | undefined): string {
  const org = canonicalOrganization(organization);
  const model = slugWithVersionDots(modelName);
  return org === "unknown" ? `arena/${model}` : `${org}/${model}`;
}

function canonicalOrganization(value: string | undefined): string {
  const lower = (value ?? "").toLowerCase();
  if (lower.includes("anthropic")) return "anthropic";
  if (lower.includes("openai")) return "openai";
  if (lower.includes("google") || lower.includes("deepmind")) return "google";
  if (lower.includes("xai") || lower.includes("x-ai")) return "x-ai";
  if (lower.includes("z.ai") || lower === "zai") return "z-ai";
  if (lower.includes("meta")) return "meta";
  if (lower.includes("moonshot")) return "moonshotai";
  if (lower.includes("mistral")) return "mistralai";
  if (lower.includes("qwen") || lower.includes("alibaba")) return "qwen";
  if (lower.includes("deepseek")) return "deepseek";
  return slugify(value);
}

function slugWithVersionDots(value: string): string {
  const normalized = slugify(value).replace(/-+/g, "-");
  const dates: string[] = [];
  const protectedDates = normalized.replace(/\d{4}-\d{2}-\d{2}/g, (match) => {
    dates.push(match);
    return `date${dates.length - 1}placeholder`;
  });
  const dotted = protectedDates.replace(/(\d{1,2})-(\d{1,2})(?=-|$)/g, "$1.$2");
  return dotted.replace(/date(\d+)placeholder/g, (_, index: string) => dates[Number(index)]);
}

function forecastRecord(row: ForecastRow, fetchedAt: string): SourceRecord[] {
  const modelName = stringValue(row.Model);
  const organization = stringValue(row["Model Organization"]);
  if (!modelName || !organization || isForecastBaseline(modelName)) return [];
  const variant = parseForecastVariant(modelName);
  const canonicalId = `${canonicalOrganization(organization)}/${slugWithVersionDots(variant.baseName)}`;
  const sourceEvidence = evidence(
    "forecastbench",
    FORECASTBENCH_BASELINE_URL,
    fetchedAt,
    ["benchmark", "evaluation_configuration", "metadata"],
    [],
    "ForecastBench baseline track: model-only probabilistic forecasting without tools or external scaffolding.",
  );
  const normalized = baseRecord({
    sourceId: "forecastbench",
    rawId: canonicalId,
    publisher: organization,
    name: variant.baseName,
    fetchedAt,
    url: FORECASTBENCH_PAGE_URL,
    evidenceFields: ["benchmark", "evaluation_configuration", "metadata"],
  });
  normalized.aliases = [
    ...(normalized.aliases ?? []),
    alias(modelName, "forecastbench", "evaluation_model_name"),
  ];
  normalized.reasoning = variant.effort
    ? [reasoningSupport("forecastbench", { supported: true, supported_efforts: [variant.effort] }, fetchedAt, FORECASTBENCH_BASELINE_URL)]
    : [];
  normalized.benchmarks = [
    forecastObservation("dataset", row.Dataset, row["N dataset"], row["Dataset 95% CI"], variant, modelName, organization, sourceEvidence),
    forecastObservation("market", row.Market, row["N market"], row["Market 95% CI"], variant, modelName, organization, sourceEvidence),
    forecastObservation("overall", row.Overall, row.N, row["Overall 95% CI"], variant, modelName, organization, sourceEvidence),
  ].filter((observation): observation is BenchmarkObservation => Boolean(observation));
  normalized.evidence = [sourceEvidence];
  return normalized.benchmarks.length > 0 ? [normalized] : [];
}

function forecastObservation(
  dimension: string,
  value: unknown,
  sampleCount: unknown,
  confidenceInterval: unknown,
  variant: ModelVariant,
  sourceModelName: string,
  organization: string,
  sourceEvidence: ReturnType<typeof evidence>,
): BenchmarkObservation | undefined {
  const score = numeric(value);
  if (score === undefined) return undefined;
  const interval = parseConfidenceInterval(confidenceInterval);
  return {
    benchmark_id: `forecastbench.baseline.${dimension}`,
    value: score,
    metric: "brier_index",
    unit: "points",
    ...(variant.variant ? { variant: variant.variant } : {}),
    ...(variant.effort ? { effort: variant.effort } : {}),
    evaluator: "forecastbench",
    dataset_version: "current",
    ...(numeric(sampleCount) !== undefined ? { sample_count: Math.round(numeric(sampleCount)!) } : {}),
    metrics: {
      ...(interval ? { confidence_interval_lower: interval[0], confidence_interval_upper: interval[1] } : {}),
      organization,
      source_model_name: sourceModelName,
    },
    configuration: {
      track: "baseline",
      tools: false,
      scaffolding: false,
      score_direction: "higher_is_better",
    },
    evidence: sourceEvidence,
  };
}

function forecastDefinitions(fetchedAt: string): BenchmarkDefinition[] {
  return ["dataset", "market", "overall"].map((dimension) => ({
    id: `forecastbench.baseline.${dimension}`,
    kind: "benchmark",
    name: `ForecastBench baseline ${dimension}`,
    category: "forecasting",
    description: "Model-only ForecastBench baseline track. Scores are Brier Index points; higher is better. Tool-enabled tournament results are intentionally excluded from the model-level feed.",
    version: "current",
    dataset_type: "dynamic_probabilistic_forecasting",
    url: FORECASTBENCH_PAGE_URL,
    evidence: evidence("forecastbench", FORECASTBENCH_BASELINE_URL, fetchedAt, ["benchmark_definition", "evaluation_configuration"]),
  }));
}

function parseForecastVariant(value: string): ModelVariant {
  let baseName = value.replace(/[†*]/g, "").replace(/\s+/g, " ").trim();
  let variant: string | undefined;
  const modifier = baseName.match(/-(superforecaster-with-news|scratchpad|with-news|freeze-values|non-reasoning|reasoning)(?:-\d+)?$/i);
  if (modifier) {
    variant = modifier[1].toLowerCase();
    baseName = baseName.slice(0, modifier.index).trim();
  } else {
    const tokenBudget = baseName.match(/-(\d{3,5})$/);
    if (tokenBudget && isLikelyTokenBudget(baseName, tokenBudget[1])) {
      variant = `token_budget_${tokenBudget[1]}`;
      baseName = baseName.slice(0, tokenBudget.index).trim();
    }
  }
  const effortMatch = baseName.match(/-(low|medium|high|xhigh|max)$/i);
  const effort = effortMatch?.[1].toLowerCase();
  if (effortMatch) baseName = baseName.slice(0, effortMatch.index).trim();
  return { baseName, variant, effort };
}

function isForecastBaseline(value: string): boolean {
  return /^(?:public median forecast|superforecaster median forecast|imputed forecaster|naive forecaster|llm crowd\b.*|always \d(?:\.\d+)?|random uniform)$/i.test(value.replace(/[†*]/g, "").trim());
}

function isLikelyTokenBudget(value: string, suffix: string): boolean {
  if (!/^(?:1024|2048|4096|8192|16384|32768|65536|131072)$/.test(suffix)) return false;
  return /^claude(?:-|\s)/i.test(value) || /-\d{8}-\d+$/.test(value);
}

function parseConfidenceInterval(value: unknown): [number, number] | undefined {
  const match = stringValue(value)?.match(/^\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]$/);
  if (!match) return undefined;
  const lower = numeric(match[1]);
  const upper = numeric(match[2]);
  return lower === undefined || upper === undefined ? undefined : [lower, upper];
}

function humanize(value: string): string {
  return value.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function extractAssignedArray(text: string, variable: string): string {
  const match = new RegExp(`\\b(?:const|let|var)\\s+${variable}\\s*=\\s*\\[`).exec(text);
  if (!match) throw new Error(`source did not contain a ${variable} array assignment`);
  const start = match.index + match[0].length - 1;
  return balancedArray(text, start);
}

function balancedArray(text: string, start: number): string {
  let depth = 0;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "[") depth += 1;
    else if (character === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  throw new Error("source contained an unterminated data array");
}

class LiteralParser {
  private index = 0;

  constructor(private readonly text: string) {}

  parse(): unknown {
    const value = this.value();
    this.whitespace();
    if (this.index !== this.text.length) throw new Error("unsupported trailing data in source literal");
    return value;
  }

  private value(): unknown {
    this.whitespace();
    const character = this.text[this.index];
    if (character === "[") return this.array();
    if (character === "{") return this.object();
    if (character === "'" || character === '"') return this.string();
    const token = this.token();
    if (token === "null") return null;
    if (token === "true") return true;
    if (token === "false") return false;
    const number = Number(token);
    if (token !== "" && Number.isFinite(number)) return number;
    throw new Error(`unsupported source literal token: ${token}`);
  }

  private array(): unknown[] {
    this.expect("[");
    const output: unknown[] = [];
    this.whitespace();
    if (this.peek("]")) {
      this.index += 1;
      return output;
    }
    while (true) {
      output.push(this.value());
      this.whitespace();
      if (this.peek("]")) {
        this.index += 1;
        return output;
      }
      this.expect(",");
    }
  }

  private object(): Record<string, unknown> {
    this.expect("{");
    const output: Record<string, unknown> = {};
    this.whitespace();
    if (this.peek("}")) {
      this.index += 1;
      return output;
    }
    while (true) {
      this.whitespace();
      const key = this.text[this.index] === "'" || this.text[this.index] === '"' ? this.string() : this.token();
      if (typeof key !== "string" || key === "") throw new Error("source object contained an invalid key");
      this.whitespace();
      this.expect(":");
      output[key] = this.value();
      this.whitespace();
      if (this.peek("}")) {
        this.index += 1;
        return output;
      }
      this.expect(",");
    }
  }

  private string(): string {
    const quote = this.text[this.index];
    this.index += 1;
    let output = "";
    while (this.index < this.text.length) {
      const character = this.text[this.index++];
      if (character === quote) return output;
      if (character !== "\\") {
        output += character;
        continue;
      }
      const escaped = this.text[this.index++];
      if (escaped === "n") output += "\n";
      else if (escaped === "r") output += "\r";
      else if (escaped === "t") output += "\t";
      else if (escaped === "u") {
        const code = this.text.slice(this.index, this.index + 4);
        if (!/^[0-9a-f]{4}$/i.test(code)) throw new Error("invalid unicode escape in source literal");
        output += String.fromCharCode(Number.parseInt(code, 16));
        this.index += 4;
      } else output += escaped;
    }
    throw new Error("unterminated string in source literal");
  }

  private token(): string {
    const start = this.index;
    while (this.index < this.text.length && !/[\s,\]}:]/.test(this.text[this.index])) this.index += 1;
    return this.text.slice(start, this.index);
  }

  private whitespace(): void {
    while (/\s/.test(this.text[this.index] ?? "")) this.index += 1;
  }

  private peek(value: string): boolean {
    return this.text[this.index] === value;
  }

  private expect(value: string): void {
    if (!this.peek(value)) throw new Error(`source literal expected ${value}`);
    this.index += 1;
  }
}
