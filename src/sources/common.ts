import { canonicalModelId, alias, splitRoutingVariant } from "../identity.js";
import type { Evidence, Model, Offer, SourceRecord } from "../types.js";
import { mergeCapabilities, modalities, reasoningSupport } from "../source-utils.js";
import { arrayOfStrings, boolValue, numberValue, stringValue } from "../utils.js";

export function baseRecord(input: {
  sourceId: string;
  rawId?: unknown;
  publisher?: unknown;
  name?: unknown;
  family?: unknown;
  releaseDate?: unknown;
  knowledgeCutoff?: unknown;
  openWeights?: unknown;
  license?: unknown;
  contextTokens?: unknown;
  maxOutputTokens?: unknown;
  modalities?: unknown;
  parameters?: unknown;
  reasoning?: unknown;
  fetchedAt: string;
  url: string;
  evidenceFields: string[];
}): SourceRecord {
  const identity = canonicalModelId({ sourceId: input.sourceId, rawId: input.rawId, publisher: input.publisher, name: input.name });
  const sourceModelId = identity.sourceModelId;
  const creator = stringValue(input.publisher);
  const name = stringValue(input.name) ?? sourceModelId;
  const modelModalities = modalities(input.modalities);
  const parameters = arrayOfStrings(input.parameters);
  const record: SourceRecord = {
    id: identity.id,
    identity_confidence: identity.confidence,
    name,
    creators: creator ? [creator] : [],
    ...(stringValue(input.family) ? { family: stringValue(input.family) } : {}),
    aliases: [alias(sourceModelId, input.sourceId), alias(identity.id, input.sourceId, "canonical_id")],
    ...(stringValue(input.releaseDate) ? { release_date: stringValue(input.releaseDate) } : {}),
    ...(stringValue(input.knowledgeCutoff) ? { knowledge_cutoff: stringValue(input.knowledgeCutoff) } : {}),
    ...(typeof boolValue(input.openWeights) === "boolean" ? { open_weights: boolValue(input.openWeights) } : { open_weights: null }),
    ...(stringValue(input.license) ? { license: stringValue(input.license) } : {}),
    modalities: modelModalities,
    ...(numberValue(input.contextTokens) !== undefined ? { context_tokens: numberValue(input.contextTokens) } : {}),
    ...(numberValue(input.maxOutputTokens) !== undefined ? { max_output_tokens: numberValue(input.maxOutputTokens) } : {}),
    capabilities: mergeCapabilities(parameters.length > 0 ? {
      tools: parameters.includes("tools"),
      structured_outputs: parameters.includes("structured_outputs"),
      response_format: parameters.includes("response_format"),
      reasoning: parameters.includes("reasoning") || parameters.includes("include_reasoning") || null,
    } : undefined),
    reasoning: input.reasoning !== undefined || parameters.length > 0
      ? [reasoningSupport(input.sourceId, input.reasoning, input.fetchedAt, input.url, parameters)]
      : [],
    offers: [],
    benchmarks: [],
    pricing_observations: [],
    runtime_observations: [],
    measurements: [],
    evidence: [],
  };
  return record;
}

export function offer(input: {
  id: string;
  providerId: string;
  providerName?: unknown;
  providerModelId: unknown;
  variant?: unknown;
  status?: Offer["status"];
  expiresAt?: unknown;
  quantization?: unknown;
  contextTokens?: unknown;
  maxOutputTokens?: unknown;
  supportedParameters?: unknown;
  capabilities?: Record<string, boolean | null>;
  reasoningEfforts?: string[];
  dataPolicy?: Record<string, unknown>;
  pricing?: Offer["pricing"];
  runtime?: Offer["runtime"];
  evidence: Evidence[];
}): Offer {
  const providerModelId = stringValue(input.providerModelId) ?? "unknown";
  const variant = stringValue(input.variant) ?? splitRoutingVariant(providerModelId).variant;
  return {
    id: input.id,
    provider_id: input.providerId,
    ...(stringValue(input.providerName) ? { provider_name: stringValue(input.providerName) } : {}),
    provider_model_id: providerModelId,
    ...(variant ? { variant } : {}),
    status: input.status ?? "active",
    ...(stringValue(input.expiresAt) ? { expires_at: stringValue(input.expiresAt) } : {}),
    ...(stringValue(input.quantization) ? { quantization: stringValue(input.quantization) } : {}),
    ...(numberValue(input.contextTokens) !== undefined ? { context_tokens: numberValue(input.contextTokens) } : {}),
    ...(numberValue(input.maxOutputTokens) !== undefined ? { max_output_tokens: numberValue(input.maxOutputTokens) } : {}),
    supported_parameters: arrayOfStrings(input.supportedParameters).sort(),
    capabilities: input.capabilities ?? {},
    reasoning_efforts: [...new Set(input.reasoningEfforts ?? [])].sort(),
    ...(input.dataPolicy ? { data_policy: input.dataPolicy } : {}),
    pricing: input.pricing ?? [],
    runtime: input.runtime ?? [],
    measurements: [],
    evidence: input.evidence,
  };
}

export function mergeSourceRecord(target: SourceRecord, extra: Partial<SourceRecord>): SourceRecord {
  return {
    ...target,
    ...extra,
    creators: [...new Set([...(target.creators ?? []), ...(extra.creators ?? [])])].sort(),
    aliases: [...(target.aliases ?? []), ...(extra.aliases ?? [])],
    capabilities: mergeCapabilities(target.capabilities, extra.capabilities),
    reasoning: [...(target.reasoning ?? []), ...(extra.reasoning ?? [])],
    offers: [...(target.offers ?? []), ...(extra.offers ?? [])],
    benchmarks: [...(target.benchmarks ?? []), ...(extra.benchmarks ?? [])],
    pricing_observations: [...(target.pricing_observations ?? []), ...(extra.pricing_observations ?? [])],
    runtime_observations: [...(target.runtime_observations ?? []), ...(extra.runtime_observations ?? [])],
    measurements: [...(target.measurements ?? []), ...(extra.measurements ?? [])],
    evidence: [...(target.evidence ?? []), ...(extra.evidence ?? [])],
  };
}

export function newRecordMap(records: SourceRecord[]): Map<string, SourceRecord> {
  const map = new Map<string, SourceRecord>();
  for (const record of records) map.set(record.id, map.has(record.id) ? mergeSourceRecord(map.get(record.id)!, record) : record);
  return map;
}

export function asModelRecord(record: SourceRecord): Model {
  return {
    id: record.id,
    identity_confidence: record.identity_confidence ?? "unresolved",
    name: record.name ?? record.id,
    creators: record.creators ?? [],
    ...(record.family ? { family: record.family } : {}),
    aliases: record.aliases ?? [],
    ...(record.release_date ? { release_date: record.release_date } : {}),
    ...(record.knowledge_cutoff ? { knowledge_cutoff: record.knowledge_cutoff } : {}),
    open_weights: record.open_weights ?? null,
    ...(record.license ? { license: record.license } : {}),
    modalities: record.modalities ?? { input: [], output: [] },
    ...(record.context_tokens !== undefined ? { context_tokens: record.context_tokens } : {}),
    ...(record.max_output_tokens !== undefined ? { max_output_tokens: record.max_output_tokens } : {}),
    capabilities: record.capabilities ?? {},
    reasoning: record.reasoning ?? [],
    offers: record.offers ?? [],
    benchmarks: record.benchmarks ?? [],
    pricing_observations: record.pricing_observations ?? [],
    runtime_observations: record.runtime_observations ?? [],
    measurements: record.measurements ?? [],
    evidence: record.evidence ?? [],
  };
}
