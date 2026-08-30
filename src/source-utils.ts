import type { Evidence, RuntimeObservation } from "./types.js";
import { asArray, asRecord, arrayOfStrings, boolValue, nestedNumberMap, numberValue, stringValue } from "./utils.js";

export { stringValue } from "./utils.js";

export function evidence(
  sourceId: string,
  url: string,
  fetchedAt: string,
  fields: string[],
  derivedFrom: string[] = [],
  note?: string,
): Evidence {
  return {
    source_id: sourceId,
    url: redactUrl(url),
    fetched_at: fetchedAt,
    status: derivedFrom.length > 0 ? "derived" : "observed",
    fields: [...new Set(fields)].sort(),
    ...(derivedFrom.length > 0 ? { derived_from: [...new Set(derivedFrom)].sort() } : {}),
    ...(note ? { note: note.slice(0, 300) } : {}),
  };
}

export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) url.username = "[redacted]";
    if (url.password) url.password = "[redacted]";
    for (const key of [...url.searchParams.keys()]) {
      if (["key", "apikey", "token", "accesstoken", "authorization", "xapikey"].includes(key.toLowerCase().replaceAll(/[-_]/g, ""))) url.searchParams.set(key, "[redacted]");
    }
    return url.toString();
  } catch {
    return value.replace(/([?&](?:key|api_key|token|authorization|x-api-key)=)[^&]*/gi, "$1[redacted]");
  }
}

export function providerName(value: unknown): string | undefined {
  return stringValue(value);
}

export function modalities(value: unknown): { input: string[]; output: string[] } {
  const record = asRecord(value);
  return {
    input: arrayOfStrings(record.input ?? record.input_modalities),
    output: arrayOfStrings(record.output ?? record.output_modalities),
  };
}

export function capabilitiesFromParameters(parameters: unknown): Record<string, boolean | null> {
  const params = arrayOfStrings(parameters);
  const has = (name: string): boolean | null => (params.length === 0 ? null : params.includes(name));
  return {
    tools: has("tools"),
    structured_outputs: has("structured_outputs"),
    response_format: has("response_format"),
    reasoning: has("reasoning") || has("include_reasoning"),
    vision: null,
    audio: null,
  };
}

export function mergeCapabilities(...values: Array<Record<string, boolean | null> | undefined>): Record<string, boolean | null> {
  const keys = new Set(values.flatMap((value) => Object.keys(value ?? {})));
  return Object.fromEntries([...keys].sort().map((key) => {
    const entries = values.map((value) => value?.[key]).filter((value): value is boolean => typeof value === "boolean");
    return [key, entries.includes(true) ? true : entries.length > 0 ? false : null];
  }));
}

export function reasoningSupport(
  sourceId: string,
  raw: unknown,
  fetchedAt: string,
  url: string,
  parameters?: unknown,
): { source_id: string; supported: boolean | null; mandatory?: boolean; efforts?: string[]; controls?: string[]; evidence: Evidence } {
  const record = asRecord(raw);
  const controls = [...new Set([
    ...arrayOfStrings(record.controls),
    ...arrayOfStrings(parameters).filter((value) => ["reasoning", "reasoning_effort", "include_reasoning"].includes(value)),
    ...Object.keys(record).filter((key) => ["effort", "budget_tokens", "toggle", "max_tokens"].includes(key)),
  ])].sort();
  const efforts = arrayOfStrings(record.supported_efforts ?? record.efforts);
  const supported = typeof record.supported === "boolean" ? record.supported : (Object.keys(record).length > 0 || controls.length > 0 ? true : null);
  return {
    source_id: sourceId,
    supported,
    ...(typeof record.mandatory === "boolean" ? { mandatory: record.mandatory } : {}),
    ...(efforts.length > 0 ? { efforts } : {}),
    ...(controls.length > 0 ? { controls } : {}),
    evidence: evidence(sourceId, url, fetchedAt, ["reasoning"]),
  };
}

export function runtimeFromEndpoint(
  sourceId: string,
  url: string,
  fetchedAt: string,
  raw: Record<string, any>,
  derivedFrom: string[] = [],
): RuntimeObservation {
  const latency = metricSeries(raw.latency_last_30m ?? raw.latency);
  const throughput = metricSeries(raw.throughput_last_30m ?? raw.throughput);
  const uptime = metricSeries(raw.uptime_last_30m ?? raw.uptime);
  for (const [statistic, percent] of Object.entries(uptime)) {
    if (percent < 0 || percent > 100) throw new Error("OpenRouter uptime must be a percentage between 0 and 100");
    uptime[statistic] = percent / 100;
  }
  return {
    scope: "offer",
    window: "30m",
    ...(Object.keys(latency).length > 0 ? { latency_seconds: latency } : {}),
    ...(Object.keys(throughput).length > 0 ? { throughput_tokens_per_second: throughput } : {}),
    ...(Object.keys(uptime).length > 0 ? { uptime_fraction: uptime } : {}),
    evidence: evidence(sourceId, url, fetchedAt, ["runtime"], derivedFrom),
  };
}

export function runtimeFromMetrics(
  sourceId: string,
  url: string,
  fetchedAt: string,
  raw: unknown,
  derivedFrom: string[] = [],
): RuntimeObservation {
  const values = nestedNumberMap(raw);
  return {
    scope: "model",
    metrics: Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b))),
    evidence: evidence(sourceId, url, fetchedAt, ["performance"], derivedFrom),
  };
}

function metricSeries(value: unknown): Record<string, number> {
  const number = numberValue(value);
  if (number !== undefined) return { value: number };
  const record = asRecord(value);
  const result: Record<string, number> = {};
  for (const key of ["p50", "p75", "p90", "p95", "p99", "value"]) {
    const parsed = numberValue(record[key]);
    if (parsed !== undefined) result[key] = parsed;
  }
  return result;
}

export function cleanOptional(value: unknown): string | undefined {
  return stringValue(value);
}

export function numeric(value: unknown): number | undefined {
  return numberValue(value);
}

export function boolean(value: unknown): boolean | undefined {
  return boolValue(value);
}

export function record(value: unknown): Record<string, any> {
  return asRecord(value);
}

export function list(value: unknown): any[] {
  return asArray(value);
}
