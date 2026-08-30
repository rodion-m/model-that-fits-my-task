import type { Evidence, Offer, SourceRecord, SourceResult } from "../types.js";
import { fetchJson, mapWithConcurrency } from "../http.js";
import { canonicalModelId } from "../identity.js";
import { normalizeOpenRouterPricing } from "../price.js";
import { baseRecord, offer } from "./common.js";
import { capabilitiesFromParameters, evidence, numeric, record, runtimeFromEndpoint, stringValue } from "../source-utils.js";
import { arrayOfStrings, asArray, asRecord, boolValue, mergeUniqueStrings } from "../utils.js";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models?output_modalities=all";
const OPENROUTER_API = "https://openrouter.ai/api/v1";

interface OpenRouterOptions {
  fetchImpl?: typeof fetch;
  previous?: { models?: Array<{ id: string; offers?: Offer[]; evidence?: Evidence[] }> };
  includeEndpoints?: boolean;
  endpointCap?: number;
  endpointConcurrency?: number;
}

export async function collectOpenRouter(options: OpenRouterOptions = {}): Promise<SourceResult> {
  const fetchedAt = new Date().toISOString();
  const headers = process.env.OPENROUTER_API_KEY ? { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` } : undefined;
  const payload = await fetchJson<any>(OPENROUTER_MODELS_URL, {
    fetchImpl: options.fetchImpl,
    headers,
    timeoutMs: 30_000,
    maxBytes: 8 * 1024 * 1024,
    retries: 1,
  });
  const rows = asArray(payload?.data);
  if (rows.length === 0) throw new Error("OpenRouter catalog returned no models");
  const records = rows.map((row) => normalizeModel(row, fetchedAt));
  const endpointIdsByModel = new Map<string, Set<string>>();
  for (const row of rows) {
    const modelId = normalizedEndpointModelId(stringValue(row.id) ?? stringValue(row.canonical_slug) ?? "unknown");
    endpointIdsByModel.set(modelId, new Set([...(endpointIdsByModel.get(modelId) ?? []), ...catalogEndpointIds(row)]));
  }
  const warnings: string[] = [];
  const refreshedEndpointModelIds = new Set<string>();
  const includeEndpoints = options.includeEndpoints ?? process.env.OPENROUTER_ENDPOINTS !== "0";
  if (includeEndpoints) {
    const cap = options.endpointCap ?? positiveEnv("OPENROUTER_ENDPOINT_CAP", 120);
    const concurrency = options.endpointConcurrency ?? positiveEnv("OPENROUTER_ENDPOINT_CONCURRENCY", 6);
    if (!Number.isSafeInteger(cap) || cap < 0 || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error("OpenRouter endpoint cap must be a nonnegative integer and concurrency must be between 1 and 32");
    const previousById = new Map(options.previous?.models?.map((model) => [model.id, model]) ?? []);
    const attemptedAt = (row: any): number => {
      const modelId = canonicalModelId({ sourceId: "openrouter", rawId: row.id, publisher: row.id?.split?.("/")[0], name: row.name }).id;
      const previous = previousById.get(modelId);
      const observations = [...(previous?.evidence ?? []).filter((item) => item.fields?.includes("endpoint_catalog_attempt")),
        ...(previous?.offers ?? []).flatMap((value) => value.evidence.filter((item) => item.source_id === "openrouter"))];
      return Math.max(0, ...observations.map((item) => Date.parse(item.fetched_at)).filter(Number.isFinite));
    };
    const targets = rows
      .filter((row) => stringValue(row?.canonical_slug) || stringValue(row?.id))
      .map((row) => ({ row, attempted: attemptedAt(row) }))
      .sort((a, b) => a.attempted - b.attempted || String(a.row.id).localeCompare(String(b.row.id)))
      .map(({ row }) => row)
      .slice(0, cap);
    const endpointResults = await mapWithConcurrency(targets, concurrency, async (row) => {
      const pathId = stringValue(row.canonical_slug) ?? stringValue(row.id)!;
      const encoded = pathId.split("/").map(encodeURIComponent).join("/");
      const url = `${OPENROUTER_API}/models/${encoded}/endpoints`;
      try {
        const response = await fetchJson<any>(url, {
          fetchImpl: options.fetchImpl,
          headers,
          timeoutMs: 15_000,
          maxBytes: 2 * 1024 * 1024,
          retries: 0,
        });
        const endpoints = response?.data?.endpoints ?? response?.endpoints;
        if (!Array.isArray(endpoints)) throw new Error("OpenRouter endpoint response is missing its endpoints array");
        const acceptedIds = catalogEndpointIds(row);
        const resolvedId = stringValue(response?.data?.id ?? response?.id);
        if (!resolvedId || !acceptedIds.has(normalizedEndpointModelId(resolvedId))) {
          throw new Error(`OpenRouter endpoint identity mismatch: requested ${pathId}, resolved ${resolvedId ?? "missing"}`);
        }
        for (const endpoint of endpoints) {
          const endpointId = stringValue(endpoint?.model_id);
          if (!endpointId || !acceptedIds.has(normalizedEndpointModelId(endpointId))) {
            throw new Error(`OpenRouter endpoint identity mismatch: requested ${pathId}, endpoint ${endpointId ?? "missing"}`);
          }
        }
        return { row, url, endpoints, error: undefined };
      } catch (error) {
        return { row, url, endpoints: [], error: error instanceof Error ? error.message : String(error) };
      }
    });
    const byId = new Map(records.map((record) => [record.id, record]));
    for (const result of endpointResults) {
      const identity = canonicalModelId({ sourceId: "openrouter", rawId: result.row.id, publisher: result.row.id?.split?.("/")[0], name: result.row.name });
      const target = byId.get(identity.id);
      if (!target) continue;
      target.evidence?.push(evidence("openrouter", result.url, fetchedAt, ["endpoint_catalog_attempt"], [],
        result.error ? "Endpoint refresh failed; retained offers keep their original observation timestamps." : "Endpoint catalog checked, including an explicitly empty result."));
      if (result.error) {
        warnings.push(`${stringValue(result.row.id) ?? "unknown"}: ${result.error}`);
        continue;
      }
      refreshedEndpointModelIds.add(identity.id);
      for (const endpoint of result.endpoints) {
        const endpointRecord = record(endpoint);
        const providerId = stringValue(endpointRecord.provider_name) ?? "unknown";
        const endpointModelId = stringValue(endpointRecord.model_id) ?? stringValue(result.row.id) ?? "unknown";
        const variant = stringValue(endpointRecord.tag);
        const quantization = stringValue(endpointRecord.quantization);
        const runtime = runtimeFromEndpoint("openrouter", result.url, fetchedAt, endpointRecord);
        const dataPolicy = endpointRecord.data_policy
          ?? (endpointRecord.data_collection !== undefined ? { data_collection: endpointRecord.data_collection } : undefined)
          ?? (endpointRecord.zdr !== undefined ? { zdr: Boolean(endpointRecord.zdr) } : undefined);
        const endpointOffer = offer({
          id: `openrouter:${providerId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}:${endpointModelId}:${variant ?? "default"}:${quantization ?? "unknown"}`,
          providerId: providerId.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "unknown",
          providerName: providerId,
          providerModelId: endpointModelId,
          variant,
          expiresAt: endpointRecord.expiration_date ?? result.row.expiration_date,
          quantization,
          contextTokens: endpointRecord.context_length,
          maxOutputTokens: endpointRecord.max_completion_tokens,
          supportedParameters: endpointRecord.supported_parameters ?? result.row.supported_parameters,
          capabilities: {
            ...capabilitiesFromParameters(endpointRecord.supported_parameters ?? result.row.supported_parameters),
            implicit_caching: boolValue(endpointRecord.supports_implicit_caching) ?? null,
          },
          reasoningEfforts: arrayOfStrings(result.row?.reasoning?.supported_efforts),
          dataPolicy,
          pricing: normalizeOpenRouterPricing(endpointRecord.pricing ?? result.row.pricing, identity.id),
          runtime: [runtime],
          evidence: [evidence("openrouter", result.url, fetchedAt, ["provider", "quantization", "pricing", "runtime", "supported_parameters"])],
        });
        target.offers = [...(target.offers ?? []), endpointOffer];
      }
    }
  }
  preservePreviousEndpointOffers(records, options.previous, refreshedEndpointModelIds, endpointIdsByModel, warnings);
  return {
    source_id: "openrouter",
    url: OPENROUTER_MODELS_URL,
    fetched_at: fetchedAt,
    status: "ok",
    records,
    warnings: [...new Set(warnings)],
    replace_previous: true,
  };
}

function preservePreviousEndpointOffers(
  records: SourceRecord[],
  previous: OpenRouterOptions["previous"],
  refreshedModelIds: Set<string>,
  endpointIdsByModel: Map<string, Set<string>>,
  warnings: string[],
): void {
  if (!previous?.models) return;
  const previousById = new Map(previous.models.map((model) => [model.id, model]));
  for (const current of records) {
    if (refreshedModelIds.has(current.id)) continue;
    const previousModel = previousById.get(current.id);
    if (!previousModel) continue;
    if (!current.evidence?.some((item) => item.fields?.includes("endpoint_catalog_attempt"))) {
      current.evidence = [...(current.evidence ?? []), ...(previousModel.evidence ?? []).filter((item) => item.source_id === "openrouter" && item.fields?.includes("endpoint_catalog_attempt"))];
    }
    const existingIds = new Set((current.offers ?? []).map((value) => value.id));
    const retained = (previousModel.offers ?? []).flatMap((value) => {
      const projection = value.source_projections?.openrouter
        ?? (value.evidence.every((item) => item.source_id === "openrouter") ? value : undefined);
      if (projection && !endpointIdsByModel.get(current.id)?.has(normalizedEndpointModelId(projection.provider_model_id))) {
        warnings.push(`${current.id}: discarded retained OpenRouter endpoint for a different model: ${projection.provider_model_id}`);
        return [];
      }
      return projection && !existingIds.has(projection.id) ? [projection] : [];
    });
    current.offers = [...(current.offers ?? []), ...structuredClone(retained)];
  }
}

function normalizedEndpointModelId(id: string): string {
  return canonicalModelId({ sourceId: "openrouter", rawId: id }).id;
}

function catalogEndpointIds(row: any): Set<string> {
  return new Set([stringValue(row?.id), stringValue(row?.canonical_slug)]
    .filter((id): id is string => id !== undefined).map(normalizedEndpointModelId));
}

function normalizeModel(row: any, fetchedAt: string): SourceRecord {
  const id = stringValue(row?.id) ?? stringValue(row?.canonical_slug) ?? row?.name ?? "unknown";
  const publisher = id.includes("/") ? id.split("/")[0] : undefined;
  const record = baseRecord({
    sourceId: "openrouter",
    rawId: id,
    publisher,
    name: row?.name,
    contextTokens: row?.context_length,
    maxOutputTokens: row?.top_provider?.max_completion_tokens,
    modalities: row?.architecture,
    parameters: row?.supported_parameters,
    reasoning: row?.reasoning,
    fetchedAt,
    url: OPENROUTER_MODELS_URL,
    evidenceFields: ["metadata", "capabilities", "pricing", "benchmarks"],
  });
  const canonical = canonicalModelId({ sourceId: "openrouter", rawId: id, publisher, name: row?.name });
  record.aliases = [
    ...(record.aliases ?? []),
    ...(stringValue(row?.canonical_slug) ? [{ id: stringValue(row.canonical_slug)!, source_id: "openrouter", kind: "canonical_slug" }] : []),
    ...(stringValue(row?.hugging_face_id) ? [{ id: stringValue(row.hugging_face_id)!, source_id: "openrouter", kind: "hugging_face_id" }] : []),
  ];
  record.id = canonical.id;
  record.pricing_observations = row?.pricing
    ? [{ pricing: normalizeOpenRouterPricing(row.pricing, canonical.id), evidence: evidence("openrouter", OPENROUTER_MODELS_URL, fetchedAt, ["pricing"], [], "Top-provider catalog pricing; provider-specific offers are separate.") }]
    : [];
  const benchmarkValues = flattenBenchmarks(row?.benchmarks);
  record.benchmarks = benchmarkValues.map(({ id: benchmarkId, value }) => ({
    benchmark_id: benchmarkId,
    value,
    evidence: evidence("openrouter", OPENROUTER_MODELS_URL, fetchedAt, ["benchmarks"], benchmarkId.startsWith("artificial_analysis") ? ["artificial-analysis"] : []),
  }));
  const addedAt = numeric(row?.created);
  const catalogMetadata = [
    ...(addedAt === undefined ? [] : [`added_at=${new Date(addedAt * 1000).toISOString()}`]),
    ...(stringValue(row?.architecture?.tokenizer) ? [`tokenizer=${stringValue(row.architecture.tokenizer)}`] : []),
  ];
  record.evidence = [evidence("openrouter", OPENROUTER_MODELS_URL, fetchedAt, ["metadata", "capabilities", "pricing", "benchmarks"], [],
    catalogMetadata.length > 0 ? `OpenRouter catalog metadata: ${catalogMetadata.join("; ")}.` : undefined), ...(record.evidence ?? [])];
  return record;
}

function flattenBenchmarks(value: unknown): Array<{ id: string; value: number }> {
  const output: Array<{ id: string; value: number }> = [];
  function visit(current: unknown, path: string[]): void {
    if (typeof current === "number" && Number.isFinite(current)) {
      output.push({ id: path.join("."), value: current });
      return;
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) return;
    for (const [key, child] of Object.entries(current)) visit(child, [...path, key]);
  }
  visit(value, []);
  return output;
}

function positiveEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive decimal integer`);
  return parsed;
}
