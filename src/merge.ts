import { contentHash, stableValue } from "./hash.js";
import { SCHEMA_VERSION, WORKLOAD_PROFILES } from "./constants.js";
import type { BenchmarkDefinition, Evidence, Model, Offer, Snapshot, SourceRecord, SourceResult } from "./types.js";
import { asModelRecord } from "./sources/common.js";
import { canonicalizeBenchmarkDefinition, canonicalizeBenchmarkObservation } from "./benchmark-registry.js";
import { applyMetadata, mergeMetadata, metadataOf, metadataProjections } from "./provenance.js";
import { assertSnapshotShape } from "./schema.js";
import { isAvailabilityEvidence } from "../.agents/skills/model-that-fits-my-task/scripts/catalog-scope.mjs";

export function emptySnapshot(now = new Date().toISOString()): Snapshot {
  const snapshot: Snapshot = {
    schema_version: SCHEMA_VERSION,
    generated_at: now,
    content_hash: "",
    workload_profiles: WORKLOAD_PROFILES,
    sources: [],
    benchmarks: [],
    models: [],
  };
  snapshot.content_hash = contentHash(hashableSnapshot(snapshot));
  return snapshot;
}

export function mergeSnapshots(previous: Snapshot | undefined, results: SourceResult[], now = new Date().toISOString()): Snapshot {
  const modelMap = new Map<string, Model>();
  for (const model of previous?.models ?? []) modelMap.set(model.id, clone(model));
  const benchmarkMap = new Map<string, BenchmarkDefinition>();
  for (const rawBenchmark of previous?.benchmarks ?? []) {
    const benchmark = canonicalizeBenchmarkDefinition(clone(rawBenchmark));
    benchmarkMap.set(benchmark.id, benchmark);
  }

  for (const result of results) {
    if (result.status !== "ok" || !result.replace_previous) continue;
    for (const [id, model] of modelMap) {
      const stripped = withoutSource(model, result.source_id);
      if (hasModelData(stripped)) modelMap.set(id, stripped);
      else modelMap.delete(id);
    }
    for (const [id, benchmark] of benchmarkMap) {
      if (benchmark.evidence.source_id === result.source_id) {
        benchmarkMap.delete(id);
      }
    }
  }

  for (const result of results) {
    if (result.status !== "ok") continue;
    for (const record of result.records) {
      const current = modelMap.get(record.id);
      modelMap.set(record.id, current ? mergeModel(current, record, result.source_id)
        : normalizeModel(applyMetadata(asModelRecord(record), { [result.source_id]: metadataOf(record) })));
    }
    for (const rawBenchmark of result.benchmark_definitions ?? []) {
      const benchmark = canonicalizeBenchmarkDefinition(rawBenchmark);
      const current = benchmarkMap.get(benchmark.id);
      benchmarkMap.set(benchmark.id, current ? {
        ...current,
        aliases: [...new Set([...(current.aliases ?? []), ...(benchmark.aliases ?? [])])].sort(),
      } : benchmark);
    }
  }

  const statuses = mergeStatuses(previous?.sources ?? [], results);
  const snapshot: Snapshot = {
    schema_version: SCHEMA_VERSION,
    generated_at: now,
    content_hash: "",
    workload_profiles: WORKLOAD_PROFILES,
    sources: statuses,
    benchmarks: [...benchmarkMap.values()].sort((a, b) => a.id.localeCompare(b.id)),
    models: [...modelMap.values()].map(normalizeModel).sort((a, b) => a.id.localeCompare(b.id)),
  };
  snapshot.content_hash = contentHash(hashableSnapshot(snapshot));
  validateSnapshot(snapshot);
  return snapshot;
}

export function validateSnapshot(snapshot: Snapshot): void {
  assertSnapshotShape(snapshot);
}

export function hashableSnapshot(snapshot: Snapshot): unknown {
  return stableValue({
    schema_version: snapshot.schema_version,
    workload_profiles: snapshot.workload_profiles,
    benchmarks: snapshot.benchmarks,
    models: snapshot.models,
  });
}

function normalizeModel(model: Model): Model {
  return {
    ...model,
    creators: [...new Set(model.creators)].sort(),
    aliases: dedupBy(model.aliases, (value) => `${value.source_id}:${value.kind ?? ""}:${value.id}`).sort(compareById),
    modalities: {
      input: [...new Set(model.modalities?.input ?? [])].sort(),
      output: [...new Set(model.modalities?.output ?? [])].sort(),
    },
    capabilities: sortObject(model.capabilities),
    reasoning: dedupBy(model.reasoning, (value) => `${value.source_id}:${value.evidence.url}`).sort((a, b) => a.source_id.localeCompare(b.source_id)),
    offers: dedupBy(mergeOffers([], model.offers), (value) => value.id).sort(compareById),
    benchmarks: mergeBenchmarkObservations(model.benchmarks).sort((a, b) => benchmarkKey(a).localeCompare(benchmarkKey(b))),
    pricing_observations: dedupBy(model.pricing_observations, observationKey).sort((a, b) => observationKey(a).localeCompare(observationKey(b))),
    runtime_observations: dedupBy(model.runtime_observations, runtimeKey).sort((a, b) => runtimeKey(a).localeCompare(runtimeKey(b))),
    measurements: dedupBy(model.measurements, measurementKey).sort((a, b) => measurementKey(a).localeCompare(measurementKey(b))),
    evidence: mergeEvidence([], model.evidence),
  };
}

function mergeModel(current: Model, record: SourceRecord, sourceId: string): Model {
  const incoming = asModelRecord(record);
  const projections = metadataProjections(current);
  projections[sourceId] = mergeMetadata(projections[sourceId] ?? {}, metadataOf(record));
  return normalizeModel(applyMetadata({
    ...current,
    aliases: [...current.aliases, ...incoming.aliases],
    reasoning: [...current.reasoning, ...incoming.reasoning],
    offers: mergeOffers(current.offers, incoming.offers),
    benchmarks: mergeBenchmarkSets(current.benchmarks, incoming.benchmarks),
    pricing_observations: mergeByKey(current.pricing_observations, incoming.pricing_observations, observationKey),
    runtime_observations: mergeByKey(current.runtime_observations, incoming.runtime_observations, runtimeKey),
    measurements: mergeByKey(current.measurements, incoming.measurements, measurementKey),
    evidence: mergeEvidence(current.evidence, incoming.evidence),
  }, projections));
}

function normalizeOffer(currentOffer: Offer): Offer {
  return {
    ...currentOffer,
    supported_parameters: [...new Set(currentOffer.supported_parameters)].sort(),
    reasoning_efforts: [...new Set(currentOffer.reasoning_efforts)].sort(),
    pricing: dedupBy(currentOffer.pricing, (value) => JSON.stringify(value)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    runtime: dedupBy(currentOffer.runtime, runtimeKey).sort((a, b) => runtimeKey(a).localeCompare(runtimeKey(b))),
    measurements: dedupBy(currentOffer.measurements, measurementKey).sort((a, b) => measurementKey(a).localeCompare(measurementKey(b))),
    evidence: mergeEvidence([], currentOffer.evidence),
  };
}

function mergeOffers(current: Offer[], incoming: Offer[]): Offer[] {
  const map = new Map<string, Offer>();
  for (const item of [...current, ...incoming]) {
    const key = offerKey(item);
    const existing = map.get(key);
    map.set(key, existing ? combineOfferProjections({ ...offerProjections(existing), ...offerProjections(item) })
      : item.source_projections ? combineOfferProjections(item.source_projections) : normalizeOffer(item));
  }
  return [...map.values()];
}

function offerProjections(value: Offer): Record<string, Omit<Offer, "source_projections">> {
  if (value.source_projections) return { ...value.source_projections };
  const sources = [...new Set(value.evidence.map((item) => item.source_id))];
  return sources.length === 1 ? { [sources[0]]: value } : {};
}

function combineOfferProjections(projections: NonNullable<Offer["source_projections"]>): Offer {
  const values = Object.entries(projections).sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
  if (values.length === 0) throw new Error("offer has no attributable source projection");
  let combined = values[0];
  for (const value of values.slice(1)) combined = {
    ...combined,
    ...pickDefined(value),
    pricing: [...combined.pricing, ...value.pricing],
    runtime: [...combined.runtime, ...value.runtime],
    measurements: [...combined.measurements, ...value.measurements],
    supported_parameters: [...combined.supported_parameters, ...value.supported_parameters],
    reasoning_efforts: [...combined.reasoning_efforts, ...value.reasoning_efforts],
    capabilities: mergeCapabilities(combined.capabilities, value.capabilities),
    evidence: mergeEvidence(combined.evidence, value.evidence),
  };
  const operational = values.filter((value) => value.evidence.some(isAvailabilityEvidence));
  const status = operational.some((value) => value.status === "absent") ? "absent"
    : operational.some((value) => value.status === "active") ? "active" : "unknown";
  return normalizeOffer({ ...combined, status, ...(values.length > 1 ? { source_projections: projections } : {}) });
}

function mergeStatuses(previous: Snapshot["sources"], results: SourceResult[]): Snapshot["sources"] {
  const previousById = new Map(previous.map((source) => [source.source_id, source]));
  for (const result of results) {
    const old = previousById.get(result.source_id);
    previousById.set(result.source_id, {
      source_id: result.source_id,
      url: result.url,
      status: result.status,
      attempted_at: result.fetched_at,
      ...(result.status === "ok" ? { last_success_at: result.fetched_at } : old?.last_success_at ? { last_success_at: old.last_success_at } : {}),
      // This is the retained projection's source-record count, not the failed
      // attempt's empty result. The next refresh uses it as its drop baseline.
      record_count: result.status === "ok" ? result.records.length : old?.record_count ?? 0,
      warning_count: result.warnings?.length ?? 0,
      ...(result.error ? { error: result.error.slice(0, 300) } : {}),
    });
  }
  return [...previousById.values()].sort((a, b) => a.source_id.localeCompare(b.source_id));
}

function offerKey(value: Offer): string {
  return `${value.provider_id}:${value.provider_model_id}:${value.variant ?? ""}:${value.quantization ?? ""}`;
}

function benchmarkKey(value: Model["benchmarks"][number]): string {
  return `${value.evidence.source_id}:${value.benchmark_id}:${value.variant ?? ""}:${value.effort ?? ""}:${value.evaluator ?? ""}:${value.dataset_version ?? ""}:${value.metric ?? ""}:${value.unit ?? ""}:${JSON.stringify(stableValue(value.configuration ?? {}))}:${value.value}`;
}

function mergeBenchmarkObservations(values: Model["benchmarks"]): Model["benchmarks"] {
  const map = new Map<string, Model["benchmarks"][number]>();
  for (const rawValue of values) {
    const value = canonicalizeBenchmarkObservation(rawValue);
    const key = benchmarkKey(value);
    const current = map.get(key);
    map.set(key, current ? {
      ...current,
      source_benchmark_ids: [...new Set([...(current.source_benchmark_ids ?? []), ...(value.source_benchmark_ids ?? [])])].sort(),
    } : value);
  }
  return [...map.values()];
}

function mergeBenchmarkSets(current: Model["benchmarks"], incoming: Model["benchmarks"]): Model["benchmarks"] {
  const normalizedIncoming = incoming.map(canonicalizeBenchmarkObservation);
  const replacedRawKeys = new Set(normalizedIncoming.flatMap((value) => rawBenchmarkKeys(value)));
  const retained = current
    .map(canonicalizeBenchmarkObservation)
    .filter((value) => !rawBenchmarkKeys(value).some((key) => replacedRawKeys.has(key)));
  return mergeBenchmarkObservations([...retained, ...normalizedIncoming]);
}

function rawBenchmarkKeys(value: Model["benchmarks"][number]): string[] {
  return (value.source_benchmark_ids ?? [value.benchmark_id]).map((rawId) =>
    JSON.stringify([value.evidence.source_id, rawId, value.variant ?? null, value.effort ?? null,
      value.metric ?? null, value.unit ?? null, value.evaluator ?? null, value.dataset_version ?? null,
      stableValue(value.configuration ?? {})])
  );
}

function observationKey(value: Model["pricing_observations"][number]): string {
  return `${value.evidence.source_id}:${value.evidence.url}`;
}

function runtimeKey(value: Model["runtime_observations"][number]): string {
  return `${value.evidence.source_id}:${value.evidence.url}:${value.scope}`;
}

function measurementKey(value: Model["measurements"][number]): string {
  return `${value.evidence.source_id}:${value.offer_id}:${value.workload_profile_id ?? ""}:${JSON.stringify(value.reasoning_config ?? {})}`;
}

function mergeEvidence(current: Evidence[], incoming: Evidence[] = []): Evidence[] {
  const map = new Map<string, Evidence>();
  for (const item of [...current, ...incoming]) {
    const key = `${item.source_id}:${item.url}:${(item.fields ?? []).join(",")}`;
    map.set(key, item);
  }
  return [...map.values()].sort((a, b) => `${a.source_id}:${a.url}`.localeCompare(`${b.source_id}:${b.url}`));
}

function mergeByKey<T>(current: T[], incoming: T[], key: (value: T) => string): T[] {
  const map = new Map<string, T>();
  for (const item of [...current, ...incoming]) map.set(key(item), item);
  return [...map.values()];
}

function withoutSource(model: Model, sourceId: string): Model {
  const projections = metadataProjections(model);
  const hasMetadata = Boolean(projections[sourceId]) || model.evidence.some((value) => value.source_id === sourceId);
  delete projections[sourceId];
  const stripped = {
    ...model,
    aliases: model.aliases.filter((value) => value.source_id !== sourceId),
    reasoning: model.reasoning.filter((value) => value.source_id !== sourceId),
    offers: model.offers.flatMap((value) => {
      if (!value.evidence.some((item) => item.source_id === sourceId)) return [value];
      const contributions = offerProjections(value);
      delete contributions[sourceId];
      return Object.keys(contributions).length > 0 ? [combineOfferProjections(contributions)] : [];
    }),
    benchmarks: model.benchmarks.filter((value) => value.evidence.source_id !== sourceId),
    pricing_observations: model.pricing_observations.filter((value) => value.evidence.source_id !== sourceId),
    runtime_observations: model.runtime_observations.filter((value) => value.evidence.source_id !== sourceId),
    measurements: model.measurements.filter((value) => value.evidence.source_id !== sourceId),
    evidence: model.evidence.filter((value) => value.source_id !== sourceId),
  };
  return normalizeModel(hasMetadata ? applyMetadata(stripped, projections) : stripped);
}

function hasModelData(model: Model): boolean {
  return model.evidence.length > 0 || model.offers.length > 0 || model.benchmarks.length > 0
    || model.pricing_observations.length > 0 || model.runtime_observations.length > 0 || model.measurements.length > 0;
}

function mergeCapabilities(...values: Array<Record<string, boolean | null>>): Record<string, boolean | null> {
  const keys = new Set(values.flatMap((value) => Object.keys(value ?? {})));
  return Object.fromEntries([...keys].sort().map((key) => {
    const booleans = values.map((value) => value[key]).filter((value): value is boolean => typeof value === "boolean");
    return [key, booleans.includes(true) ? true : booleans.length > 0 ? false : null];
  }));
}

function pickDefined<T extends Record<string, any>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined)) as Partial<T>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function dedupBy<T>(items: T[], key: (value: T) => string): T[] {
  const map = new Map<string, T>();
  for (const item of items) map.set(key(item), item);
  return [...map.values()];
}

function compareById(a: { id: string }, b: { id: string }): number {
  return a.id.localeCompare(b.id);
}

function sortObject(value: Record<string, any>): Record<string, any> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}
