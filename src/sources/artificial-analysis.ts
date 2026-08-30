import type { SourceRecord, SourceResult } from "../types.js";
import { fetchJson } from "../http.js";
import { canonicalModelId } from "../identity.js";
import { normalizeMillionPricing } from "../price.js";
import { baseRecord, mergeSourceRecord, newRecordMap } from "./common.js";
import { evidence, numeric, record, runtimeFromMetrics, stringValue } from "../source-utils.js";
import { asArray, asRecord, numberValue } from "../utils.js";

export const AA_FREE_URL = "https://artificialanalysis.ai/api/v2/language/models/free";

export async function collectArtificialAnalysis(options: { fetchImpl?: typeof fetch; apiKey?: string } = {}): Promise<SourceResult> {
  const fetchedAt = new Date().toISOString();
  const apiKey = options.apiKey ?? process.env.AA_API_KEY;
  if (!apiKey) {
    return { source_id: "artificial_analysis", url: AA_FREE_URL, fetched_at: fetchedAt, status: "skipped", records: [], warnings: ["AA_API_KEY is not configured"] };
  }
  const payload = await fetchJson<any>(AA_FREE_URL, {
    fetchImpl: options.fetchImpl,
    headers: { "x-api-key": apiKey },
    timeoutMs: 30_000,
    maxBytes: 12 * 1024 * 1024,
    retries: 0,
  });
  const rows = asArray(payload?.data);
  if (payload?.has_more === true) throw new Error("Artificial Analysis collection is incomplete: undocumented additional pages are available");
  if (rows.length === 0) throw new Error("Artificial Analysis free endpoint returned no models");
  const records = rows.map((row) => normalize(row, fetchedAt));
  return {
    source_id: "artificial_analysis",
    url: AA_FREE_URL,
    fetched_at: fetchedAt,
    status: "ok",
    records: [...newRecordMap(records).values()],
    warnings: payload?.has_more ? ["AA pagination is available; only the first documented page is fetched"] : [],
  };
}

function normalize(row: any, fetchedAt: string): SourceRecord {
  const item = record(row);
  const creator = stringValue(item.model_creator?.name ?? item.model_creator?.id ?? item.model_creator);
  const identity = canonicalModelId({ sourceId: "artificial_analysis", rawId: item.id ?? item.slug, publisher: creator, name: item.name });
  const normalized = baseRecord({
    sourceId: "artificial_analysis",
    rawId: item.id ?? item.slug,
    publisher: creator,
    name: item.name,
    releaseDate: item.release_date,
    fetchedAt,
    url: AA_FREE_URL,
    evidenceFields: ["metadata", "evaluations", "pricing", "performance"],
  });
  normalized.id = identity.id;
  normalized.benchmarks = flattenNumeric(item.evaluations).map(({ id, value }) => ({
    benchmark_id: `artificial_analysis.${id}`,
    value,
    evidence: evidence("artificial_analysis", AA_FREE_URL, fetchedAt, ["evaluations"]),
  }));
  const pricing = normalizeMillionPricing(item.pricing);
  normalized.pricing_observations = pricing.length > 0
    ? [{ pricing, evidence: evidence("artificial_analysis", AA_FREE_URL, fetchedAt, ["pricing"]) }]
    : [];
  normalized.runtime_observations = item.performance
    ? [runtimeFromMetrics("artificial_analysis", AA_FREE_URL, fetchedAt, item.performance)]
    : [];
  normalized.evidence = [evidence("artificial_analysis", AA_FREE_URL, fetchedAt, ["metadata", "evaluations", "pricing", "performance"])];
  return normalized;
}

function flattenNumeric(value: unknown): Array<{ id: string; value: number }> {
  const output: Array<{ id: string; value: number }> = [];
  function visit(current: unknown, path: string[]): void {
    const parsed = numberValue(current);
    if (parsed !== undefined) {
      output.push({ id: path.join("."), value: parsed });
      return;
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) return;
    for (const [key, child] of Object.entries(asRecord(current))) visit(child, [...path, key]);
  }
  visit(value, []);
  return output;
}
