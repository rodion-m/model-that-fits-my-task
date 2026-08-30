import { EVIDENCE_STALE_MS, MAX_LIMIT, WORKLOAD_PROFILES } from "./constants.js";
import { estimateWorkloadCost, workloadCompatibility } from "./cost.js";
import { scoreDirection } from "./lane.js";
import { queryIndex, type Facets, type IndexedModel, type IndexedOffer } from "./query-index.js";
import {
  QueryInputError,
  getter,
  parseBoolean,
  parseDate,
  parseEnum,
  parseInteger,
  parseModelSort,
  parseNonNegative,
  parseObservationSort,
  parseOfferSort,
  parsePaging,
  parseScope,
  parseView,
  resolveWorkloadProfile,
  valuesFor,
  type QueryScope,
} from "./query-params.js";
import type { ApiEnvelope, BenchmarkObservation, Model, Offer, Snapshot, WorkloadProfile } from "./types.js";
import { stableSort } from "./utils.js";

const MAX_FULL_MODEL_LIMIT = 10;

export { QueryInputError };

export interface ModelSummary {
  id: string;
  name: string;
  identity_confidence: Model["identity_confidence"];
  family?: string;
  release_date?: string;
  open_weights: boolean | null;
  modalities: Model["modalities"];
  context_tokens?: number;
  max_output_tokens?: number;
  capabilities: string[];
  providers: string[];
  offer_count: number;
  reasoning_efforts: string[];
  quantizations: string[];
  benchmark_ids: string[];
  source_ids: string[];
}

export interface FlatOffer extends Offer {
  model_id: string;
  model_name: string;
  estimated_cost_usd?: number | null;
  missing_dimensions?: string[];
  cost_components?: Record<string, number | null>;
  workload_profile_id?: string;
  workload_profile?: WorkloadProfile;
  workload_compatibility?: ReturnType<typeof workloadCompatibility>;
}

export interface FlatBenchmarkObservation extends BenchmarkObservation {
  model_id: string;
  model_name: string;
  lane_id: string;
}

export function listModels(snapshot: Snapshot, params: URLSearchParams | Record<string, string | undefined>): ApiEnvelope<Model | ModelSummary> {
  const get = getter(params);
  const scope = parseScope(get("scope"));
  const view = parseView(get("view"));
  const q = get("q")?.toLowerCase();
  const providers = valuesFor(params, "provider");
  const modalities = valuesFor(params, "modality");
  const capabilities = valuesFor(params, "capability");
  const efforts = valuesFor(params, "reasoning_effort");
  const quantizations = valuesFor(params, "quantization");
  const sources = valuesFor(params, "source");
  const parameters = valuesFor(params, "supported_parameter");
  const benchmark = get("benchmark")?.toLowerCase();
  const openWeights = parseBoolean(get("open_weights"), "open_weights");
  const minContext = parseInteger(get("min_context"), "min_context");
  const hasRuntime = parseBoolean(get("has_runtime"), "has_runtime");
  const hasCachePricing = parseBoolean(get("has_cache_pricing"), "has_cache_pricing");
  const releasedAfter = parseDate(get("released_after"), "released_after");
  const releasedBefore = parseDate(get("released_before"), "released_before");
  if (releasedAfter && releasedBefore && releasedAfter > releasedBefore) {
    throw new QueryInputError("released_after", "released_after must be on or before released_before");
  }
  const sort = parseModelSort(get("sort"));
  const offerScoped = {
    providers,
    capabilities,
    efforts,
    quantizations,
    parameters,
    minContext,
    hasRuntime,
    hasCachePricing,
  };
  let models = queryIndex(snapshot).models.filter((row) => {
    if (q && !row.search.includes(q)) return false;
    if (!modalities.every((modality) => row.modalities.has(modality))) return false;
    if (sources.length > 0 && !sources.some((source) => row.sources.has(source))) return false;
    if (benchmark && ![...row.benchmarks, ...row.benchmarkAliases].some((value) => value === benchmark || value.includes(benchmark))) return false;
    if (openWeights !== undefined && row.model.open_weights !== openWeights) return false;
    if (releasedAfter && (!row.model.release_date || row.model.release_date.slice(0, 10) < releasedAfter)) return false;
    if (releasedBefore && (!row.model.release_date || row.model.release_date.slice(0, 10) > releasedBefore)) return false;
    if (!matchesOfferScopedConstraints(row, offerScoped, "all")) return false;
    return true;
  });
  const beforeScope = models.length;
  if (scope === "available") models = models.filter((row) => row.inAvailableScope && matchesOfferScopedConstraints(row, offerScoped, scope));
  models = sortModels(models, sort, scope);
  const data: Array<Model | ModelSummary> = view === "summary" ? models.map((row) => summarizeModel(row, scope)) : models.map((row) => row.model);
  return paginate(data, get("limit"), get("offset"), snapshot, view === "summary" ? MAX_LIMIT : MAX_FULL_MODEL_LIMIT, {
    scope,
    excluded_count: scope === "available" ? beforeScope - models.length : 0,
  });
}

export function getModel(snapshot: Snapshot, id: string): Model | undefined {
  let decoded: string;
  try { decoded = decodeURIComponent(id); }
  catch { throw new QueryInputError("id", "id must be valid URI-encoded text"); }
  return queryIndex(snapshot).byId.get(decoded) ?? queryIndex(snapshot).byAlias.get(decoded);
}

export function listOffers(snapshot: Snapshot, params: URLSearchParams | Record<string, string | undefined>): ApiEnvelope<FlatOffer> {
  const get = getter(params);
  const scope = parseScope(get("scope"));
  const providers = valuesFor(params, "provider");
  const modelIds = valuesFor(params, "model");
  const modalities = valuesFor(params, "modality");
  const q = get("q")?.toLowerCase();
  const capabilities = valuesFor(params, "capability");
  const parameters = valuesFor(params, "supported_parameter");
  const efforts = valuesFor(params, "reasoning_effort");
  const quantizations = valuesFor(params, "quantization");
  const sources = valuesFor(params, "source");
  const minContext = parseInteger(get("min_context"), "min_context");
  const hasRuntime = parseBoolean(get("has_runtime"), "has_runtime");
  const hasCachePricing = parseBoolean(get("has_cache_pricing"), "has_cache_pricing");
  const profile = resolveWorkloadProfile(get);
  const maxCost = parseNonNegative(get("max_cost_usd"), "max_cost_usd");
  const sort = parseOfferSort(get("sort"));
  if (maxCost !== undefined && !profile) throw new QueryInputError("max_cost_usd", "max_cost_usd requires profile");
  if (sort === "cost" && !profile) throw new QueryInputError("sort", "sort=cost requires profile");
  let indexedOffers = queryIndex(snapshot).offers.filter((row) => {
    if (providers.length > 0 && !providers.includes(row.providerId)) return false;
    if (modelIds.length > 0 && !modelIds.includes(row.flat.model_id.toLowerCase())) return false;
    if (!modalities.every((modality) => row.modelModalities.has(modality))) return false;
    if (q && !row.search.includes(q)) return false;
    if (!capabilities.every((capability) => row.capabilities.has(capability))) return false;
    if (!parameters.every((parameter) => row.parameters.has(parameter))) return false;
    if (efforts.length > 0 && !efforts.some((effort) => row.efforts.has(effort))) return false;
    if (quantizations.length > 0 && (!row.quantization || !quantizations.includes(row.quantization))) return false;
    if (sources.length > 0 && !sources.some((source) => row.sources.has(source))) return false;
    if (minContext !== undefined && (row.offer.context_tokens ?? 0) < minContext) return false;
    if (hasRuntime !== undefined && row.hasRuntime !== hasRuntime) return false;
    if (hasCachePricing !== undefined && row.hasCachePricing !== hasCachePricing) return false;
    return true;
  });
  const costs = new Map<IndexedOffer, ReturnType<typeof estimateWorkloadCost>>();
  const compatibility = new Map<IndexedOffer, ReturnType<typeof workloadCompatibility>>();
  if (profile) {
    for (const row of indexedOffers) {
      costs.set(row, estimateWorkloadCost(row.offer, profile));
      compatibility.set(row, workloadCompatibility(row.offer, profile));
    }
    if (maxCost !== undefined) {
      indexedOffers = indexedOffers.filter((row) => {
        const estimated = costs.get(row)?.estimated_cost_usd;
        return compatibility.get(row)?.status === "compatible" && estimated !== null && estimated !== undefined && estimated <= maxCost;
      });
    }
  }
  const beforeScope = indexedOffers.length;
  if (scope === "available") indexedOffers = indexedOffers.filter((row) => row.inAvailableScope);
  const excludedCount = scope === "available" ? beforeScope - indexedOffers.length : 0;
  const offers = stableSort(indexedOffers.map((row) => {
    if (!profile) return row.flat;
    const cost = costs.get(row)!;
    return {
      ...row.flat,
      workload_profile_id: profile.id,
      workload_profile: profile,
      workload_compatibility: compatibility.get(row),
      estimated_cost_usd: cost.estimated_cost_usd,
      missing_dimensions: cost.missing_dimensions,
      cost_components: cost.components,
    };
  }), (a, b) => {
    if (sort === "context") return (b.context_tokens ?? 0) - (a.context_tokens ?? 0) || a.id.localeCompare(b.id);
    if (sort === "cost" && profile) {
      const compatibilityRank = (value: unknown): number => ({ compatible: 0, unknown: 1, incompatible: 2 })[(value as { status: "compatible" | "unknown" | "incompatible" }).status];
      const compatibilityOrder = compatibilityRank(a.workload_compatibility) - compatibilityRank(b.workload_compatibility);
      if (compatibilityOrder !== 0) return compatibilityOrder;
      const aCost = nullableNumber(a.estimated_cost_usd);
      const bCost = nullableNumber(b.estimated_cost_usd);
      if (aCost !== bCost) return aCost - bCost;
      return a.id.localeCompare(b.id);
    }
    return `${a.model_id}:${a.provider_id}:${a.provider_model_id}`.localeCompare(`${b.model_id}:${b.provider_id}:${b.provider_model_id}`);
  });
  return paginate(offers, get("limit"), get("offset"), snapshot, MAX_LIMIT, {
    scope,
    excluded_count: excludedCount,
  });
}

export function listProviders(snapshot: Snapshot, params: URLSearchParams | Record<string, string | undefined> = {}): Array<Record<string, unknown>> {
  const scope = parseScope(getter(params)("scope"));
  const index = queryIndex(snapshot);
  return scope === "all" ? index.providers : index.providersAvailable;
}

export function listBenchmarks(snapshot: Snapshot, params: URLSearchParams | Record<string, string | undefined> = {}): Array<Record<string, unknown>> {
  const kinds = valuesFor(params, "kind");
  const q = getter(params)("q")?.toLowerCase();
  if (kinds.length > 0) {
    for (const kind of kinds) {
      if (!["benchmark", "index", "aggregate", "claim"].includes(kind)) {
        throw new QueryInputError("kind", "kind must be benchmark, index, aggregate, or claim");
      }
    }
  }
  return queryIndex(snapshot).benchmarks.filter((row) => {
    if (kinds.length > 0 && !kinds.includes(String(row.kind).toLowerCase())) return false;
    if (q && ![row.id, ...(Array.isArray(row.aliases) ? row.aliases : [])].some((value) => String(value).toLowerCase().includes(q))) return false;
    return true;
  });
}

export function listBenchmarkObservations(snapshot: Snapshot, params: URLSearchParams | Record<string, string | undefined> = {}): ApiEnvelope<FlatBenchmarkObservation> {
  const get = getter(params);
  const scope = parseScope(get("scope"));
  const models = valuesFor(params, "model");
  const benchmarks = valuesFor(params, "benchmark");
  const metrics = valuesFor(params, "metric");
  const units = valuesFor(params, "unit");
  const variants = valuesFor(params, "variant");
  const efforts = valuesFor(params, "effort");
  const evaluators = valuesFor(params, "evaluator");
  const datasetVersions = valuesFor(params, "dataset_version");
  const sources = valuesFor(params, "source");
  const laneId = get("lane_id");
  const sort = parseObservationSort(get("sort"));
  const requestedDirection = parseEnum(get("direction"), "direction", ["higher", "lower"]);
  if (requestedDirection && sort !== "score") throw new QueryInputError("direction", "direction requires sort=score");
  const index = queryIndex(snapshot);
  const availableIds = new Set(index.models.filter((row) => row.inAvailableScope).map((row) => row.model.id));
  let rows = index.observations.filter((row) => {
    if (laneId && row.lane_id !== laneId) return false;
    if (models.length > 0 && !models.includes(row.model_id.toLowerCase())) return false;
    if (benchmarks.length > 0 && !benchmarks.some((value) => row.benchmark_id.toLowerCase() === value || (row.source_benchmark_ids ?? []).some((alias) => alias.toLowerCase() === value))) return false;
    if (metrics.length > 0 && !metrics.includes((row.metric ?? "").toLowerCase())) return false;
    if (units.length > 0 && !units.includes((row.unit ?? "").toLowerCase())) return false;
    if (variants.length > 0 && !variants.includes((row.variant ?? "").toLowerCase())) return false;
    if (efforts.length > 0 && !efforts.includes((row.effort ?? "").toLowerCase())) return false;
    if (evaluators.length > 0 && !evaluators.includes((row.evaluator ?? "").toLowerCase())) return false;
    if (datasetVersions.length > 0 && !datasetVersions.includes((row.dataset_version ?? "").toLowerCase())) return false;
    if (sources.length > 0 && !sources.includes(row.evidence.source_id.toLowerCase())) return false;
    return true;
  });
  const beforeScope = rows.length;
  if (scope === "available") rows = rows.filter((row) => availableIds.has(row.model_id));
  const lanes = new Set(rows.map((row) => row.lane_id));
  if (sort === "score" && lanes.size > 1) {
    throw new QueryInputError("sort", "sort=score requires a single comparison lane; pass lane_id or filters that isolate one comparison lane");
  }
  let direction: "higher" | "lower" | undefined;
  if (sort === "score" && rows.length > 0) {
    try {
      const directions = new Set(rows.map((row) => scoreDirection(row, requestedDirection)));
      if (directions.size !== 1) throw new Error("comparison lane has conflicting score directions");
      direction = [...directions][0];
    } catch (error) {
      throw new QueryInputError("direction", error instanceof Error ? error.message : "unable to resolve score direction");
    }
  }
  rows = stableSort(rows, (a, b) => {
    if (sort === "score") return (direction === "lower" ? a.value - b.value : b.value - a.value) || a.model_id.localeCompare(b.model_id);
    return `${a.lane_id}:${a.model_id}:${a.evidence.source_id}`.localeCompare(`${b.lane_id}:${b.model_id}:${b.evidence.source_id}`);
  });
  const result = paginate(rows, get("limit"), get("offset"), snapshot, MAX_LIMIT, {
    scope,
    excluded_count: scope === "available" ? beforeScope - rows.length : 0,
  });
  if (direction) result.meta.score_direction = direction;
  return result;
}

export function listProfiles(): WorkloadProfile[] {
  return WORKLOAD_PROFILES;
}

export interface FacetResponse extends Facets {
  meta: { scope: QueryScope; excluded_count: number; updated_at: string; schema_version: string };
}

export function listFacets(snapshot: Snapshot, params: URLSearchParams | Record<string, string | undefined> = {}): FacetResponse {
  const scope = parseScope(getter(params)("scope"));
  const index = queryIndex(snapshot);
  const facets = scope === "all" ? index.facetsAll : index.facets;
  const excludedCount = scope === "available" ? index.models.length - index.models.filter((row) => row.inAvailableScope).length : 0;
  return {
    ...facets,
    meta: {
      scope,
      excluded_count: excludedCount,
      updated_at: snapshot.generated_at,
      schema_version: snapshot.schema_version,
    },
  };
}

export function health(snapshot: Snapshot): Record<string, unknown> {
  const now = Date.now();
  const availableModelCount = queryIndex(snapshot).models.filter((row) => row.inAvailableScope).length;
  return {
    status: snapshot.models.length > 0 ? "ok" : "empty",
    schema_version: snapshot.schema_version,
    generated_at: snapshot.generated_at,
    content_hash: snapshot.content_hash,
    model_count: snapshot.models.length,
    available_model_count: availableModelCount,
    all_model_count: snapshot.models.length,
    source_count: snapshot.sources.length,
    default_scope: "available",
    sources: snapshot.sources.map((source) => ({
      ...source,
      stale: source.last_success_at ? now - Date.parse(source.last_success_at) > EVIDENCE_STALE_MS : true,
    })),
  };
}

function matchesOfferScopedConstraints(row: IndexedModel, constraints: {
  providers: string[];
  capabilities: string[];
  efforts: string[];
  quantizations: string[];
  parameters: string[];
  minContext: number | undefined;
  hasRuntime: boolean | undefined;
  hasCachePricing: boolean | undefined;
}, scope: QueryScope): boolean {
  const offerScopedPresent = constraints.providers.length > 0
    || constraints.capabilities.length > 0
    || constraints.efforts.length > 0
    || constraints.quantizations.length > 0
    || constraints.parameters.length > 0
    || constraints.minContext !== undefined
    || constraints.hasRuntime !== undefined
    || constraints.hasCachePricing !== undefined;
  if (!offerScopedPresent) return true;

  const offerMatch = (offer: IndexedOffer) => {
    if (scope === "available" && !offer.inAvailableScope) return false;
    if (constraints.providers.length > 0 && !constraints.providers.includes(offer.providerId)) return false;
    if (!constraints.capabilities.every((capability) => offer.capabilities.has(capability))) return false;
    if (constraints.efforts.length > 0 && !constraints.efforts.some((effort) => offer.efforts.has(effort))) return false;
    if (constraints.quantizations.length > 0 && (!offer.quantization || !constraints.quantizations.includes(offer.quantization))) return false;
    if (!constraints.parameters.every((parameter) => offer.parameters.has(parameter))) return false;
    if (constraints.minContext !== undefined && (offer.offer.context_tokens ?? 0) < constraints.minContext) return false;
    if (constraints.hasRuntime !== undefined && offer.hasRuntime !== constraints.hasRuntime) return false;
    if (constraints.hasCachePricing !== undefined && offer.hasCachePricing !== constraints.hasCachePricing) return false;
    return true;
  };

  if (row.indexedOffers.some(offerMatch)) return true;
  return false;
}

function paginate<T>(
  items: T[],
  rawLimit: string | undefined,
  rawOffset: string | undefined,
  snapshot: Snapshot,
  maxLimit = MAX_LIMIT,
  extra: { scope?: QueryScope; excluded_count?: number } = {},
): ApiEnvelope<T> {
  const paging = parsePaging(rawLimit, rawOffset, maxLimit);
  return {
    data: items.slice(paging.offset, paging.offset + paging.limit),
    meta: {
      total: items.length,
      limit: paging.limit,
      offset: paging.offset,
      has_more: paging.offset + paging.limit < items.length,
      updated_at: snapshot.generated_at,
      schema_version: snapshot.schema_version,
      ...(extra.scope ? { scope: extra.scope } : {}),
      ...(extra.excluded_count !== undefined ? { excluded_count: extra.excluded_count } : {}),
    },
  };
}

function sortModels(models: IndexedModel[], sort: "name" | "context" | "updated" | "released", scope: QueryScope): IndexedModel[] {
  return stableSort(models, (a, b) => {
    if (sort === "context") return scopedContext(b, scope) - scopedContext(a, scope) || a.model.id.localeCompare(b.model.id);
    if (sort === "updated") return b.latest.localeCompare(a.latest) || a.model.id.localeCompare(b.model.id);
    if (sort === "released") return (b.model.release_date ?? "").localeCompare(a.model.release_date ?? "") || a.model.id.localeCompare(b.model.id);
    return a.model.name.localeCompare(b.model.name) || a.model.id.localeCompare(b.model.id);
  });
}

function scopedOffers(row: IndexedModel, scope: QueryScope): IndexedOffer[] {
  return scope === "all" ? row.indexedOffers : row.indexedOffers.filter((offer) => offer.inAvailableScope);
}

function scopedContext(row: IndexedModel, scope: QueryScope): number {
  return Math.max(0, ...scopedOffers(row, scope).map((offer) => offer.offer.context_tokens ?? 0));
}

function summarizeModel(row: IndexedModel, scope: QueryScope): ModelSummary {
  const offers = scopedOffers(row, scope);
  const providers = new Set(offers.map((offer) => offer.offer.provider_id));
  const context = scopedContext(row, scope);
  const maxOutput = Math.max(0, ...offers.map((offer) => offer.offer.max_output_tokens ?? 0));
  return {
    id: row.model.id,
    name: row.model.name,
    identity_confidence: row.model.identity_confidence,
    ...(row.model.family ? { family: row.model.family } : {}),
    ...(row.model.release_date ? { release_date: row.model.release_date } : {}),
    open_weights: row.model.open_weights,
    modalities: row.model.modalities,
    ...(context > 0 ? { context_tokens: context } : {}),
    ...(maxOutput > 0 ? { max_output_tokens: maxOutput } : {}),
    capabilities: [...new Set(offers.flatMap((offer) => [...offer.capabilities]))].sort(),
    providers: [...providers].sort(),
    offer_count: offers.length,
    reasoning_efforts: [...new Set(offers.flatMap((offer) => [...offer.efforts]))].sort(),
    quantizations: [...new Set(offers.flatMap((offer) => offer.quantization ? [offer.quantization] : []))].sort(),
    benchmark_ids: [...row.benchmarks].sort(),
    source_ids: [...row.sources].sort(),
  };
}

function nullableNumber(value: number | null | undefined): number {
  return value === null || value === undefined ? Number.POSITIVE_INFINITY : value;
}
