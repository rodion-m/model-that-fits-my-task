import type { Model, Offer, Snapshot } from "./types.js";
import { comparisonLaneId } from "./lane.js";
import type { FlatBenchmarkObservation, FlatOffer } from "./query.js";
import { inAvailableScope, offerInAvailableScope } from "./scope.js";

export interface IndexedModel {
  model: Model;
  search: string;
  providers: ReadonlySet<string>;
  modalities: ReadonlySet<string>;
  capabilities: ReadonlySet<string>;
  efforts: ReadonlySet<string>;
  quantizations: ReadonlySet<string>;
  sources: ReadonlySet<string>;
  benchmarks: ReadonlySet<string>;
  benchmarkAliases: ReadonlySet<string>;
  maxContext: number;
  latest: string;
  inAvailableScope: boolean;
  indexedOffers: IndexedOffer[];
}

export interface IndexedOffer {
  flat: FlatOffer;
  offer: Offer;
  model: Model;
  search: string;
  providerId: string;
  modelModalities: ReadonlySet<string>;
  capabilities: ReadonlySet<string>;
  efforts: ReadonlySet<string>;
  parameters: ReadonlySet<string>;
  sources: ReadonlySet<string>;
  quantization?: string;
  hasRuntime: boolean;
  hasCachePricing: boolean;
  inAvailableScope: boolean;
}

export interface QueryIndex {
  models: IndexedModel[];
  offers: IndexedOffer[];
  observations: FlatBenchmarkObservation[];
  byId: Map<string, Model>;
  byAlias: Map<string, Model | undefined>;
  providers: Array<Record<string, unknown>>;
  providersAvailable: Array<Record<string, unknown>>;
  benchmarks: Array<Record<string, unknown>>;
  facets: Facets;
  facetsAll: Facets;
}

export interface Facets {
  capabilities: Array<{ value: string; model_count: number; offer_count?: number }>;
  reasoning_efforts: Array<{ value: string; model_count: number; offer_count?: number }>;
  quantizations: Array<{ value: string; model_count: number; offer_count?: number }>;
  modalities: Array<{ value: string; model_count: number; offer_count?: number }>;
  sources: Array<{ value: string; model_count: number; offer_count?: number }>;
}

const indexes = new WeakMap<Snapshot, QueryIndex>();

export function queryIndex(snapshot: Snapshot): QueryIndex {
  const existing = indexes.get(snapshot);
  if (existing) return existing;

  const models = snapshot.models.map((model) => indexModel(model, snapshot.generated_at));
  const offers = models.flatMap((row) => row.indexedOffers);
  const observations = models.flatMap((row) => row.model.benchmarks.map((observation) => ({
    ...observation,
    model_id: row.model.id,
    model_name: row.model.name,
    lane_id: comparisonLaneId(observation),
  })));
  const byId = new Map(models.map((row) => [row.model.id, row.model]));
  const byAlias = new Map<string, Model | undefined>();
  for (const row of models) for (const alias of row.model.aliases) {
    if (!byAlias.has(alias.id)) byAlias.set(alias.id, row.model);
    else if (byAlias.get(alias.id) !== row.model) byAlias.set(alias.id, undefined);
  }
  const result: QueryIndex = {
    models,
    offers,
    observations,
    byId,
    byAlias,
    providers: buildProviders(models),
    providersAvailable: buildProviders(models, true),
    benchmarks: buildBenchmarks(models, snapshot),
    facets: buildFacets(models.filter((row) => row.inAvailableScope), true),
    facetsAll: buildFacets(models),
  };
  indexes.set(snapshot, result);
  return result;
}

function buildFacets(models: IndexedModel[], availableOnly = false): Facets {
  const capabilities = new Map<string, { models: Set<string>; offers: number }>();
  const efforts = new Map<string, { models: Set<string>; offers: number }>();
  const quantizations = new Map<string, { models: Set<string>; offers: number }>();
  const modalities = new Map<string, { models: Set<string>; offers: number }>();
  const sources = new Map<string, { models: Set<string>; offers: number }>();

  const add = (map: Map<string, { models: Set<string>; offers: number }>, value: string, modelId: string, offer = false) => {
    const normalized = value.toLowerCase();
    const current = map.get(normalized) ?? { models: new Set<string>(), offers: 0 };
    current.models.add(modelId);
    if (offer) current.offers += 1;
    map.set(normalized, current);
  };

  for (const row of models) {
    for (const modality of row.model.modalities.input) add(modalities, `input:${modality}`, row.model.id);
    for (const modality of row.model.modalities.output) add(modalities, `output:${modality}`, row.model.id);
    for (const source of row.sources) add(sources, source, row.model.id);
    for (const indexedOffer of row.indexedOffers) {
      if (availableOnly && !indexedOffer.inAvailableScope) continue;
      const offer = indexedOffer.offer;
      for (const capability of indexedOffer.capabilities) add(capabilities, capability, row.model.id, true);
      for (const effort of offer.reasoning_efforts) add(efforts, effort, row.model.id, true);
      if (offer.quantization) add(quantizations, offer.quantization, row.model.id, true);
    }
  }

  const rows = (map: Map<string, { models: Set<string>; offers: number }>) => [...map.entries()]
    .map(([value, count]) => ({ value, model_count: count.models.size, ...(count.offers > 0 ? { offer_count: count.offers } : {}) }))
    .sort((a, b) => b.model_count - a.model_count || a.value.localeCompare(b.value));

  return {
    capabilities: rows(capabilities),
    reasoning_efforts: rows(efforts),
    quantizations: rows(quantizations),
    modalities: rows(modalities),
    sources: rows(sources),
  };
}

function indexModel(model: Model, generatedAt: string): IndexedModel {
  const providers = new Set<string>();
  const capabilities = new Set<string>(trueKeys(model.capabilities));
  const efforts = new Set<string>();
  const quantizations = new Set<string>();
  const sources = new Set<string>();
  const benchmarks = new Set<string>();
  const benchmarkAliases = new Set<string>();
  for (const offer of model.offers) {
    providers.add(offer.provider_id.toLowerCase());
    for (const effort of offer.reasoning_efforts) efforts.add(effort.toLowerCase());
    if (offer.reasoning_efforts.length > 0) capabilities.add("reasoning");
    for (const capability of trueKeys(offer.capabilities)) capabilities.add(capability);
    if (offer.quantization) quantizations.add(offer.quantization.toLowerCase());
    for (const evidence of offer.evidence) sources.add(evidence.source_id.toLowerCase());
  }
  for (const evidence of [...model.evidence, ...model.benchmarks.map((item) => item.evidence)]) sources.add(evidence.source_id.toLowerCase());
  for (const benchmark of model.benchmarks) {
    benchmarks.add(benchmark.benchmark_id.toLowerCase());
    for (const alias of benchmark.source_benchmark_ids ?? []) benchmarkAliases.add(alias.toLowerCase());
  }
  const search = [model.id, model.name, ...model.aliases.map((value) => value.id)].join(" ").toLowerCase();
  const modalities = new Set([
    ...model.modalities.input.map((value) => `input:${value.toLowerCase()}`),
    ...model.modalities.output.map((value) => `output:${value.toLowerCase()}`),
  ]);
  const maxContext = Math.max(model.context_tokens ?? 0, ...model.offers.map((offer) => offer.context_tokens ?? 0));
  const indexed: IndexedModel = {
    model,
    search,
    providers,
    modalities,
    capabilities,
    efforts,
    quantizations,
    sources,
    benchmarks,
    benchmarkAliases,
    maxContext,
    latest: model.evidence.map((value) => value.fetched_at).sort().at(-1) ?? "",
    inAvailableScope: inAvailableScope(model, generatedAt),
    indexedOffers: [],
  };
  indexed.indexedOffers = model.offers.map((offer) => indexOffer(indexed, offer, generatedAt));
  return indexed;
}

function indexOffer(row: IndexedModel, offer: Offer, generatedAt: string): IndexedOffer {
  const capabilities = new Set(trueKeys(offer.capabilities));
  if (offer.reasoning_efforts.length > 0) capabilities.add("reasoning");
  return {
    flat: { ...offer, model_id: row.model.id, model_name: row.model.name },
    offer,
    model: row.model,
    search: `${row.model.id} ${row.model.name} ${offer.provider_model_id}`.toLowerCase(),
    providerId: offer.provider_id.toLowerCase(),
    modelModalities: new Set([
      ...row.model.modalities.input.map((value) => `input:${value.toLowerCase()}`),
      ...row.model.modalities.output.map((value) => `output:${value.toLowerCase()}`),
    ]),
    capabilities,
    efforts: new Set(offer.reasoning_efforts.map((value) => value.toLowerCase())),
    parameters: new Set(offer.supported_parameters.map((value) => value.toLowerCase())),
    sources: new Set(offer.evidence.map((evidence) => evidence.source_id.toLowerCase())),
    ...(offer.quantization ? { quantization: offer.quantization.toLowerCase() } : {}),
    hasRuntime: offer.runtime.length > 0,
    hasCachePricing: offer.pricing.some((price) => (price.dimension === "cache_read" || price.dimension === "cache_write") && price.amount_usd_per_unit !== null),
    inAvailableScope: row.model.identity_confidence !== "unresolved" && offerInAvailableScope(offer, generatedAt),
  };
}

function buildProviders(models: IndexedModel[], availableOnly = false): Array<Record<string, unknown>> {
  const providers = new Map<string, { provider_id: string; provider_name?: string; model_ids: Set<string>; offer_count: number; quantizations: Set<string> }>();
  for (const row of models) for (const indexedOffer of row.indexedOffers) {
    if (availableOnly && !indexedOffer.inAvailableScope) continue;
    const offer = indexedOffer.offer;
    const current = providers.get(offer.provider_id) ?? { provider_id: offer.provider_id, provider_name: offer.provider_name, model_ids: new Set<string>(), offer_count: 0, quantizations: new Set<string>() };
    current.model_ids.add(row.model.id);
    current.offer_count += 1;
    if (offer.quantization) current.quantizations.add(offer.quantization);
    providers.set(offer.provider_id, current);
  }
  return [...providers.values()]
    .map((value) => ({ provider_id: value.provider_id, provider_name: value.provider_name, model_count: value.model_ids.size, offer_count: value.offer_count, quantizations: [...value.quantizations].sort() }))
    .sort((a, b) => a.provider_id.localeCompare(b.provider_id));
}

function buildBenchmarks(models: IndexedModel[], snapshot: Snapshot): Array<Record<string, unknown>> {
  const counts = new Map<string, { observations: number; models: Set<string>; sources: Set<string>; aliases: Set<string>; kinds: Set<string> }>();
  for (const row of models) for (const observation of row.model.benchmarks) {
    const current = counts.get(observation.benchmark_id) ?? { observations: 0, models: new Set<string>(), sources: new Set<string>(), aliases: new Set<string>(), kinds: new Set<string>() };
    current.observations += 1;
    current.models.add(row.model.id);
    current.sources.add(observation.evidence.source_id);
    for (const alias of observation.source_benchmark_ids ?? []) if (alias !== observation.benchmark_id) current.aliases.add(alias);
    if (observation.kind) current.kinds.add(observation.kind);
    counts.set(observation.benchmark_id, current);
  }
  const definitions = new Map(snapshot.benchmarks.map((value) => [value.id, value]));
  return [...counts.entries()].map(([id, value]) => ({
    id,
    ...(definitions.get(id) ? { definition: definitions.get(id) } : {}),
    observation_count: value.observations,
    model_count: value.models.size,
    kind: value.kinds.size === 1 ? [...value.kinds][0] : "benchmark",
    aliases: [...new Set([...(definitions.get(id)?.aliases ?? []), ...value.aliases])].sort(),
    sources: [...value.sources].sort(),
    independent_sources: [...value.sources].filter((source) => source !== "benchlm" && source !== "cloudprice" && source !== "benchgecko").sort(),
  })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function trueKeys(value: Record<string, boolean | null>): string[] {
  return Object.entries(value).filter(([, enabled]) => enabled === true).map(([key]) => key.toLowerCase());
}
