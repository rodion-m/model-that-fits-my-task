import type { BenchmarkDefinition, BenchmarkObservation, RuntimeObservation, SourceRecord, SourceResult } from "../types.js";
import { fetchText } from "../http.js";
import { evidence, mergeCapabilities, numeric, stringValue } from "../source-utils.js";
import { numberValue, slugify } from "../utils.js";
import { baseRecord, newRecordMap } from "./common.js";
import { parseCsv } from "./livebench.js";

export const OPEN_ASR_MULTILINGUAL_URL = "https://raw.githubusercontent.com/huggingface/open_asr_leaderboard/main/scripts/data/multilingual.csv";
export const OPEN_ASR_EN_SHORTFORM_URL = "https://raw.githubusercontent.com/huggingface/open_asr_leaderboard/main/scripts/data/en_shortform.csv";
export const OPEN_ASR_EN_LONGFORM_URL = "https://raw.githubusercontent.com/huggingface/open_asr_leaderboard/main/scripts/data/en_longform.csv";

type OpenAsrTrack = "multilingual" | "en_shortform" | "en_longform";

const TRACKS: Record<OpenAsrTrack, { sourceId: string; url: string; modelColumn: string; ignoredColumns: string[] }> = {
  multilingual: { sourceId: "open_asr_multilingual", url: OPEN_ASR_MULTILINGUAL_URL, modelColumn: "model", ignoredColumns: ["model", "Model size (B)", "RTFx"] },
  en_shortform: { sourceId: "open_asr_en_shortform", url: OPEN_ASR_EN_SHORTFORM_URL, modelColumn: "model", ignoredColumns: ["model", "Avg. WER", "RTFx", "Model size (B)", "License"] },
  en_longform: { sourceId: "open_asr_en_longform", url: OPEN_ASR_EN_LONGFORM_URL, modelColumn: "model_id", ignoredColumns: ["model_id", "Average", "RTFx", "Model size (B)", "Avg (without CORAAL)"] },
};

export async function collectOpenAsrMultilingual(options: { fetchImpl?: typeof fetch } = {}): Promise<SourceResult> {
  return collectOpenAsrTrack("multilingual", options);
}

export async function collectOpenAsrEnglishShortform(options: { fetchImpl?: typeof fetch } = {}): Promise<SourceResult> {
  return collectOpenAsrTrack("en_shortform", options);
}

export async function collectOpenAsrEnglishLongform(options: { fetchImpl?: typeof fetch } = {}): Promise<SourceResult> {
  return collectOpenAsrTrack("en_longform", options);
}

export async function collectOpenAsrTrack(track: OpenAsrTrack, options: { fetchImpl?: typeof fetch } = {}): Promise<SourceResult> {
  const fetchedAt = new Date().toISOString();
  const config = TRACKS[track];
  const text = await fetchText(config.url, { fetchImpl: options.fetchImpl, timeoutMs: 30_000, maxBytes: 4 * 1024 * 1024 });
  const parsed = parseCsv(text);
  if (!parsed.headers.includes(config.modelColumn)) throw new Error(`Open ASR ${track} CSV omitted ${config.modelColumn}`);
  if (parsed.rows.length === 0) throw new Error(`Open ASR ${track} CSV returned no rows`);

  const scoreColumns = parsed.headers.filter((header) => !config.ignoredColumns.includes(header));
  if (scoreColumns.length === 0) throw new Error(`Open ASR ${track} CSV returned no score columns`);
  const records = parsed.rows.flatMap((row) => buildRecord(row, track, config, scoreColumns, fetchedAt));
  if (records.length === 0) throw new Error(`Open ASR ${track} CSV returned no model records`);
  return {
    source_id: config.sourceId,
    url: config.url,
    fetched_at: fetchedAt,
    status: "ok",
    records: [...newRecordMap(records).values()],
    benchmark_definitions: scoreColumns.map((column) => benchmarkDefinition(track, column, fetchedAt, config.url)),
    replace_previous: true,
  };
}

function buildRecord(
  row: Record<string, string>,
  track: OpenAsrTrack,
  config: (typeof TRACKS)[OpenAsrTrack],
  scoreColumns: string[],
  fetchedAt: string,
): SourceRecord[] {
  const sourceModelId = stringValue(row[config.modelColumn]);
  if (!sourceModelId) return [];
  const publisher = sourceModelId.includes("/") ? sourceModelId.split("/")[0] : undefined;
  const name = sourceModelId.split("/").at(-1) ?? sourceModelId;
  const license = stringValue(row.License);
  const sourceEvidence = evidence(config.sourceId, config.url, fetchedAt, ["benchmark", "runtime", "evaluation_configuration"], [], "Published CSV from the Hugging Face Open ASR Leaderboard repository; scores are upstream results, not local measurements.");
  const normalized = baseRecord({
    sourceId: config.sourceId,
    rawId: sourceModelId,
    publisher,
    name,
    license,
    openWeights: license?.toLowerCase() === "open" ? true : license?.toLowerCase() === "proprietary" ? false : undefined,
    modalities: { input: ["audio"], output: ["text"] },
    fetchedAt,
    url: config.url,
    evidenceFields: ["benchmark", "runtime", "evaluation_configuration"],
  });
  normalized.capabilities = mergeCapabilities(normalized.capabilities, { audio: true, speech_to_text: true });
  normalized.benchmarks = scoreColumns.flatMap((column) => {
    const value = numeric(row[column]);
    if (value === undefined) return [];
    const aggregate = isAggregate(column);
    const dataset = slugify(column.replace(/\s+wer$/i, ""));
    const language = track === "multilingual" ? column.match(/^([a-z]{2})_/i)?.[1]?.toLowerCase() : "en";
    const observation: BenchmarkObservation = {
      benchmark_id: `open_asr.${track}.${slugify(column)}`,
      kind: aggregate ? "aggregate" : "benchmark",
      value,
      metric: "wer",
      unit: "percent",
      evaluator: "open_asr",
      dataset_version: track,
      configuration: { track, dataset, ...(language ? { language } : {}) },
      evidence: sourceEvidence,
    };
    return [observation];
  });

  const rtfx = numeric(row.RTFx);
  const modelSize = numberValue(row["Model size (B)"]);
  if (rtfx !== undefined || modelSize !== undefined) {
    const runtime: RuntimeObservation = {
      scope: "model",
      window: "published-run",
      metrics: {
        ...(rtfx !== undefined ? { rtfx } : {}),
        ...(modelSize !== undefined ? { model_size_b: modelSize } : {}),
      },
      evidence: evidence(config.sourceId, config.url, fetchedAt, ["runtime", "evaluation_configuration"], [], "RTFx is from the upstream plotting CSV snapshot. Hardware and runtime conditions are not published per row; no shared H200 environment is assumed.") ,
    };
    normalized.runtime_observations = [runtime];
  }
  normalized.evidence = [sourceEvidence];
  return [normalized];
}

function benchmarkDefinition(track: OpenAsrTrack, column: string, fetchedAt: string, url: string): BenchmarkDefinition {
  const aggregate = isAggregate(column);
  return {
    id: `open_asr.${track}.${slugify(column)}`,
    kind: aggregate ? "aggregate" : "benchmark",
    name: `Open ASR ${track} — ${column}`,
    category: "speech_to_text",
    version: "main",
    dataset_type: "public",
    url: "https://github.com/huggingface/open_asr_leaderboard",
    evidence: evidence(TRACKS[track].sourceId, url, fetchedAt, ["benchmark_definition"]),
  };
}

function isAggregate(column: string): boolean {
  return /^(?:avg|average)/i.test(column);
}
