import type { BenchmarkDefinition, BenchmarkObservation, Offer, RuntimeObservation, SourceRecord, SourceResult } from "../types.js";
import { fetchJson, fetchText } from "../http.js";
import { alias, unresolvedModelId } from "../identity.js";
import { evidence, mergeCapabilities, numeric, record, stringValue } from "../source-utils.js";
import { asArray, numberValue, slugify } from "../utils.js";
import { baseRecord, newRecordMap, offer } from "./common.js";
import { parseCsv } from "./livebench.js";

export const PIPECAT_STT_URL = "https://raw.githubusercontent.com/pipecat-ai/stt-benchmark/main/README.md";
export const PIPECAT_STT_SERVICES_URL = "https://raw.githubusercontent.com/pipecat-ai/stt-benchmark/main/src/stt_benchmark/services.py";
export const PIPECAT_STT_PAGE_URL = "https://github.com/pipecat-ai/stt-benchmark";
export const AA_SPEECH_TO_TEXT_FREE_URL = "https://artificialanalysis.ai/api/v2/media/speech-to-text/models/free";

interface PipecatSttRow {
  vendor: string;
  model: string;
  transcripts: number;
  perfect: number;
  werMean: number;
  pooledWer: number;
  ttfsMedian: number;
  ttfsP95: number;
  ttfsP99: number;
}

interface ParsedPipecatStt {
  rows: PipecatSttRow[];
  sampleCount?: number;
  dataset?: string;
  skippedRows: number;
}

export async function collectPipecatStt(options: { fetchImpl?: typeof fetch } = {}): Promise<SourceResult> {
  const fetchedAt = new Date().toISOString();
  const [text, servicesText] = await Promise.all([
    fetchText(PIPECAT_STT_URL, { fetchImpl: options.fetchImpl, timeoutMs: 30_000, maxBytes: 512 * 1024 }),
    fetchText(PIPECAT_STT_SERVICES_URL, { fetchImpl: options.fetchImpl, timeoutMs: 30_000, maxBytes: 512 * 1024 }),
  ]);
  const parsed = parsePipecatResults(text);
  if (parsed.rows.length === 0) throw new Error("Pipecat STT README contained no parseable result rows");
  if (parsed.skippedRows > 0) throw new Error(`Pipecat STT result table contains ${parsed.skippedRows} malformed rows; collection is incomplete`);

  const serviceKeys = servicesText ? parsePipecatServiceRegistry(servicesText) : new Map<string, string>();
  if (serviceKeys.size === 0) throw new Error("Pipecat STT service registry contained no model identifiers");
  const records = parsed.rows.map((row) => pipecatRecord(row, parsed, fetchedAt, serviceKeys));
  const definitions = pipecatDefinitions(fetchedAt);
  const warnings = [
    ...(parsed.skippedRows > 0 ? [`Pipecat STT skipped ${parsed.skippedRows} malformed result rows`] : []),
    ...(!servicesText ? ["Pipecat STT service registry was unavailable; model slugs are derived from the published README labels"] : []),
  ];
  return {
    source_id: "pipecat_stt",
    url: PIPECAT_STT_PAGE_URL,
    fetched_at: fetchedAt,
    status: "ok",
    records: [...newRecordMap(records).values()],
    benchmark_definitions: definitions,
    warnings,
    replace_previous: true,
  };
}

export function parsePipecatResults(text: string): ParsedPipecatStt {
  const block = tableBlock(text);
  const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const headerIndex = lines.findIndex((line) => {
    const cells = pipeCells(line).map((cell) => cell.toLowerCase());
    return cells[0] === "vendor" && cells[1] === "model";
  });
  if (headerIndex < 0) throw new Error("Pipecat STT README result table header was not found");

  const headers = pipeCells(lines[headerIndex]).map((header) => header.toLowerCase());
  const requiredHeaders = ["vendor", "model", "transcripts", "perfect", "wer mean", "pooled wer", "ttfs median", "ttfs p95", "ttfs p99"];
  if (requiredHeaders.some((header) => !headers.includes(header))) throw new Error("Pipecat STT README result table changed its required columns");

  const index = new Map(headers.map((header, position) => [header, position]));
  const rows: PipecatSttRow[] = [];
  let skippedRows = 0;
  for (const line of lines.slice(headerIndex + 1)) {
    const cells = pipeCells(line);
    if (!line.startsWith("|") || cells.every((cell) => /^[-: ]+$/.test(cell))) continue;
    if (cells.length < headers.length) {
      skippedRows += 1;
      continue;
    }
    const row = {
      vendor: cells[index.get("vendor")!],
      model: cells[index.get("model")!],
      transcripts: tableNumber(cells[index.get("transcripts")!]),
      perfect: tableNumber(cells[index.get("perfect")!]),
      werMean: tableNumber(cells[index.get("wer mean")!]),
      pooledWer: tableNumber(cells[index.get("pooled wer")!]),
      ttfsMedian: tableNumber(cells[index.get("ttfs median")!]),
      ttfsP95: tableNumber(cells[index.get("ttfs p95")!]),
      ttfsP99: tableNumber(cells[index.get("ttfs p99")!]),
    };
    if (!row.vendor || !row.model || Object.values(row).some((value) => value === undefined)) {
      skippedRows += 1;
      continue;
    }
    rows.push(row as PipecatSttRow);
  }

  const sampleMatch = text.match(/Benchmark results on\s+(\d+)\s+samples\s+from\s+the\s+`([^`]+)`\s+dataset/i);
  return {
    rows,
    ...(sampleMatch ? { sampleCount: Number(sampleMatch[1]), dataset: sampleMatch[2] } : {}),
    skippedRows,
  };
}

export function parsePipecatServiceRegistry(text: string): Map<string, string> {
  const serviceKeys = new Map<string, string>();
  const pattern = /"([^"\n]+)"\s*:\s*ServiceDefinition\([\s\S]*?vendor\s*=\s*"([^"\n]+)"[\s\S]*?model_label\s*=\s*"([^"\n]+)"/g;
  for (const match of text.matchAll(pattern)) {
    const [, serviceKey, vendor, model] = match;
    if (serviceKey && vendor && model) serviceKeys.set(registryKey(vendor, model), serviceKey);
  }
  return serviceKeys;
}

export async function collectArtificialAnalysisSpeechToText(options: { fetchImpl?: typeof fetch; apiKey?: string } = {}): Promise<SourceResult> {
  const fetchedAt = new Date().toISOString();
  const apiKey = options.apiKey ?? process.env.AA_API_KEY;
  if (!apiKey) {
    return {
      source_id: "artificial_analysis_stt",
      url: AA_SPEECH_TO_TEXT_FREE_URL,
      fetched_at: fetchedAt,
      status: "skipped",
      records: [],
      warnings: ["AA_API_KEY is not configured"],
    };
  }
  const payload = await fetchJson<any>(AA_SPEECH_TO_TEXT_FREE_URL, {
    fetchImpl: options.fetchImpl,
    headers: { "x-api-key": apiKey },
    timeoutMs: 30_000,
    maxBytes: 4 * 1024 * 1024,
    retries: 0,
  });
  const rows = asArray(payload?.data);
  if (rows.length === 0) throw new Error("Artificial Analysis STT free endpoint returned no models");
  const records = rows.map((row) => artificialAnalysisSttRecord(record(row), fetchedAt));
  return {
    source_id: "artificial_analysis_stt",
    url: AA_SPEECH_TO_TEXT_FREE_URL,
    fetched_at: fetchedAt,
    status: "ok",
    records: [...newRecordMap(records).values()],
    benchmark_definitions: [artificialAnalysisSpeechToTextDefinition(fetchedAt)],
    warnings: ["AA free STT data contains only the overall WER index; provider, price, speed, and per-dataset fields require a higher-tier endpoint."],
    replace_previous: true,
  };
}

function artificialAnalysisSpeechToTextDefinition(fetchedAt: string): BenchmarkDefinition {
  return {
    id: "artificial_analysis_stt.aa_wer_index",
    kind: "index",
    name: "Artificial Analysis AA-WER index",
    category: "speech_to_text",
    version: "AA-WER v2.2",
    dataset_type: "objective",
    url: "https://artificialanalysis.ai/speech-to-text/methodology",
    evidence: evidence("artificial_analysis_stt", AA_SPEECH_TO_TEXT_FREE_URL, fetchedAt, ["benchmark_definition"]),
  };
}

function pipecatRecord(row: PipecatSttRow, parsed: ParsedPipecatStt, fetchedAt: string, serviceKeys: Map<string, string>): SourceRecord {
  const providerId = speechProviderSlug(row.vendor);
  const serviceKey = serviceKeys.get(registryKey(row.vendor, row.model));
  const providerModelId = serviceKey && row.model.toLowerCase() !== "n/a" && /^[a-z0-9][a-z0-9_.:/-]*$/i.test(row.model) ? row.model : undefined;
  const rawId = providerModelId ? `${providerId}/${providerModelId}` : unresolvedModelId("pipecat_stt", `${row.vendor}/${row.model}`);
  const sourceEvidence = evidence("pipecat_stt", PIPECAT_STT_URL, fetchedAt, ["benchmark", "runtime", "evaluation_configuration"], [], "Published provider/model row from the upstream Pipecat STT README.");
  const normalized = baseRecord({
    sourceId: "pipecat_stt",
    rawId,
    publisher: row.vendor,
    name: row.model,
    modalities: { input: ["audio"], output: ["text"] },
    fetchedAt,
    url: PIPECAT_STT_URL,
    evidenceFields: ["benchmark", "runtime", "evaluation_configuration"],
  });
  if (!providerModelId) normalized.identity_confidence = "unresolved";
  normalized.aliases = [
    ...(normalized.aliases ?? []),
    alias(`${row.vendor}/${row.model}`, "pipecat_stt", "evaluation_model_id"),
    ...(serviceKey ? [alias(serviceKey, "pipecat_stt", "service_key")] : []),
  ];
  normalized.capabilities = mergeCapabilities(normalized.capabilities, { audio: true, speech_to_text: true, streaming: true });
  normalized.benchmarks = pipecatBenchmarks(row, parsed, sourceEvidence, serviceKey);
  const runtime: RuntimeObservation = {
    scope: providerModelId ? "offer" : "model",
    window: "published-run",
    metrics: {
      ttfs_median_ms: row.ttfsMedian,
      ttfs_p95_ms: row.ttfsP95,
      ttfs_p99_ms: row.ttfsP99,
    },
    evidence: sourceEvidence,
  };
  if (providerModelId) {
    const providerOffer: Offer = offer({
      id: `pipecat_stt:${providerId}:${providerModelId}`,
      providerId,
      providerName: row.vendor,
      providerModelId,
      capabilities: { audio: true, speech_to_text: true, streaming: true },
      runtime: [runtime],
      evidence: [sourceEvidence],
    });
    normalized.offers = [providerOffer];
  } else {
    normalized.runtime_observations = [runtime];
  }
  normalized.evidence = [sourceEvidence];
  return normalized;
}

function pipecatBenchmarks(row: PipecatSttRow, parsed: ParsedPipecatStt, sourceEvidence: BenchmarkObservation["evidence"], serviceKey?: string): BenchmarkObservation[] {
  const common = {
    variant: "streaming",
    evaluator: "pipecat",
    ...(parsed.dataset ? { dataset_version: parsed.dataset } : {}),
    ...(parsed.sampleCount !== undefined ? { sample_count: parsed.sampleCount } : {}),
    configuration: { language: "en", track: "streaming", ...(parsed.dataset ? { dataset: parsed.dataset } : {}) },
    ...(serviceKey ? { metrics: { service_key: serviceKey } } : {}),
    evidence: sourceEvidence,
  } as const;
  return [
    { benchmark_id: "pipecat_stt.semantic_wer_mean", value: row.werMean, metric: "semantic_wer_mean", unit: "percent", ...common },
    { benchmark_id: "pipecat_stt.semantic_wer_pooled", value: row.pooledWer, metric: "semantic_wer_pooled", unit: "percent", ...common },
    { benchmark_id: "pipecat_stt.perfect_transcript_rate", value: row.perfect, metric: "perfect_transcript_rate", unit: "percent", ...common },
    { benchmark_id: "pipecat_stt.transcript_success_rate", value: row.transcripts, metric: "transcript_success_rate", unit: "percent", ...common },
  ];
}

function pipecatDefinitions(fetchedAt: string): BenchmarkDefinition[] {
  const definitions = [
    ["semantic_wer_mean", "Pipecat semantic WER mean"],
    ["semantic_wer_pooled", "Pipecat pooled semantic WER"],
    ["perfect_transcript_rate", "Pipecat perfect transcript rate"],
    ["transcript_success_rate", "Pipecat transcript success rate"],
  ] as const;
  return definitions.map(([metric, name]) => ({
    id: `pipecat_stt.${metric}`,
    kind: "benchmark" as const,
    name,
    category: "speech_to_text",
    version: "published-readme",
    dataset_type: "objective",
    url: PIPECAT_STT_PAGE_URL,
    evidence: evidence("pipecat_stt", PIPECAT_STT_URL, fetchedAt, ["benchmark_definition"]),
  }));
}

function artificialAnalysisSttRecord(item: Record<string, any>, fetchedAt: string): SourceRecord {
  const creator = stringValue(item.model_creator?.name ?? item.model_creator) ?? "unknown";
  const modelName = withoutCreatorSuffix(stringValue(item.name) ?? "unknown", creator);
  const rawId = `${speechProviderSlug(creator)}/${speechModelSlug(modelName)}`;
  const sourceEvidence = evidence(
    "artificial_analysis_stt",
    AA_SPEECH_TO_TEXT_FREE_URL,
    fetchedAt,
    ["metadata", "benchmark"],
    [],
    "AA free STT endpoint exposes the overall AA-WER index only; per-provider and per-dataset fields are not present in this tier.",
  );
  const normalized = baseRecord({
    sourceId: "artificial_analysis_stt",
    rawId,
    publisher: creator,
    name: modelName,
    modalities: { input: ["audio"], output: ["text"] },
    openWeights: item.open_weights,
    fetchedAt,
    url: AA_SPEECH_TO_TEXT_FREE_URL,
    evidenceFields: ["metadata", "benchmark"],
  });
  normalized.aliases = [
    ...(normalized.aliases ?? []),
    ...(stringValue(item.id) ? [alias(stringValue(item.id)!, "artificial_analysis_stt", "source_uuid")] : []),
    ...(stringValue(item.name) ? [alias(stringValue(item.name)!, "artificial_analysis_stt", "display_name")] : []),
  ];
  normalized.capabilities = mergeCapabilities(normalized.capabilities, { audio: true, speech_to_text: true });
  const rawWer = numeric(item.aa_wer_index);
  normalized.benchmarks = rawWer === undefined ? [] : [{
    benchmark_id: "artificial_analysis_stt.aa_wer_index",
    kind: "index",
    value: rawWer <= 1 ? rawWer * 100 : rawWer,
    metric: "wer",
    unit: "percent",
    evaluator: "artificial_analysis",
    dataset_version: "AA-WER v2.2",
    sample_count: 1103,
    metrics: { aa_raw_fraction: rawWer, datasets: "AA-AgentTalk;VoxPopuli-Cleaned-AA;Earnings22-Cleaned-AA", weighting: "0.50;0.25;0.25" },
    evidence: sourceEvidence,
  }];
  normalized.evidence = [sourceEvidence];
  return normalized;
}

function tableBlock(text: string): string {
  const start = text.indexOf("<!-- RESULTS_TABLE:START -->");
  const end = text.indexOf("<!-- RESULTS_TABLE:END -->");
  if (start >= 0 && end > start) return text.slice(start, end);
  return text;
}

function pipeCells(line: string): string[] {
  return line.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}

function tableNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value.replaceAll("ms", "").replaceAll("%", "").trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function speechProviderSlug(value: string): string {
  const compact = value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const known: Record<string, string> = {
    assemblyai: "assemblyai",
    aws: "aws",
    azure: "azure",
    alibaba: "alibaba",
    microsoftai: "microsoft",
    smallestai: "smallest-ai",
    spacexai: "xai",
  };
  return known[compact] ?? slugify(value);
}

function registryKey(vendor: string, model: string): string {
  return `${vendor.trim().toLowerCase()}\u0000${model.trim().toLowerCase()}`;
}

function speechModelSlug(value: string): string {
  return slugify(value);
}

function withoutCreatorSuffix(value: string, creator: string): string {
  const escaped = creator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return value.replace(new RegExp(`\\s*,\\s*${escaped}\\s*$`, "i"), "").trim();
}
