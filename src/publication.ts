import { contentHash } from "./hash.js";
import { combineOfferProjections, hashableSnapshot, validateSnapshot } from "./merge.js";
import { applyMetadata } from "./provenance.js";
import type { BenchmarkDefinition, BenchmarkObservation, Evidence, Model, Offer, Snapshot } from "./types.js";

/** Artificial Analysis source ids, derived-from markers, and evaluator names. Spaces are not separators. */
export function isRestrictedPublicationName(value: string): boolean {
  return value.toLowerCase().replaceAll(/[-_]/g, "").startsWith("artificialanalysis");
}

export function publicationReview(snapshot: Snapshot): { restricted_sources: string[]; evidence_count: number } {
  const sources = new Set<string>();
  let evidenceCount = 0;
  const restricted = isRestrictedPublicationName;
  function evidenceSources(record: Record<string, unknown>): string[] {
    if (typeof record.source_id !== "string" || typeof record.fetched_at !== "string" || typeof record.url !== "string") return [];
    return [
      ...(restricted(record.source_id) ? [record.source_id] : []),
      ...(Array.isArray(record.derived_from) ? record.derived_from : [])
        .filter((source): source is string => typeof source === "string" && restricted(source)).map((source) => `derived:${source}`),
    ];
  }
  function visit(value: unknown): void {
    if (Array.isArray(value)) { for (const child of value) visit(child); return; }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    // Health statuses or aliases alone are not licensed benchmark content.
    const fromEvidence = evidenceSources(record);
    for (const source of fromEvidence) sources.add(source);
    if (fromEvidence.length) evidenceCount += 1;
    // Some republishers name the original evaluator but omit derived_from.
    if (typeof record.evaluator === "string" && restricted(record.evaluator)
      && record.evidence && typeof record.evidence === "object" && !Array.isArray(record.evidence)) {
      sources.add(`evaluator:${record.evaluator}`);
      if (!evidenceSources(record.evidence as Record<string, unknown>).length) evidenceCount += 1;
    }
    for (const child of Object.values(record)) visit(child);
  }
  visit(snapshot);
  return { restricted_sources: [...sources].sort(), evidence_count: evidenceCount };
}

export function assertPublicationAllowed(snapshot: Snapshot, licenseConfirmation?: string): ReturnType<typeof publicationReview> {
  const review = publicationReview(snapshot);
  if (review.evidence_count > 0 && licenseConfirmation !== "1") {
    throw new Error(`public publication blocked: retained Artificial Analysis data or derivatives require confirmed redistribution rights (${review.restricted_sources.join(", ")}). Review https://artificialanalysis.ai/data-api and set AA_REDISTRIBUTION_LICENSE_CONFIRMED=1 only when an applicable license has been confirmed. Local validation and builds remain available.`);
  }
  return review;
}

function evidenceIsRestricted(evidence: Evidence | undefined): boolean {
  if (!evidence || typeof evidence.source_id !== "string" || typeof evidence.fetched_at !== "string" || typeof evidence.url !== "string") return false;
  if (isRestrictedPublicationName(evidence.source_id)) return true;
  return (evidence.derived_from ?? []).some((source) => isRestrictedPublicationName(source));
}

function evaluatorIsRestricted(value: { evaluator?: string; evidence?: unknown }): boolean {
  return typeof value.evaluator === "string" && isRestrictedPublicationName(value.evaluator)
    && !!value.evidence && typeof value.evidence === "object" && !Array.isArray(value.evidence);
}

function observationIsRestricted(observation: BenchmarkObservation): boolean {
  return evidenceIsRestricted(observation.evidence) || evaluatorIsRestricted(observation);
}

function definitionIsRestricted(definition: BenchmarkDefinition): boolean {
  return evidenceIsRestricted(definition.evidence) || evaluatorIsRestricted(definition);
}

function redactOffer(offer: Offer): Offer | undefined {
  const projections = offer.source_projections;
  if (projections && Object.keys(projections).length > 0) {
    const kept: NonNullable<Offer["source_projections"]> = {};
    for (const [sourceId, projection] of Object.entries(projections)) {
      if (isRestrictedPublicationName(sourceId)) continue;
      if (projection.evidence.some(evidenceIsRestricted)) continue;
      if (projection.runtime.some((item) => evidenceIsRestricted(item.evidence))) continue;
      if (projection.measurements.some((item) => evidenceIsRestricted(item.evidence))) continue;
      kept[sourceId] = projection;
    }
    return Object.keys(kept).length > 0 ? combineOfferProjections(kept) : undefined;
  }
  if (offer.evidence.some(evidenceIsRestricted)) return undefined;
  const runtime = offer.runtime.filter((item) => !evidenceIsRestricted(item.evidence));
  const measurements = offer.measurements.filter((item) => !evidenceIsRestricted(item.evidence));
  return runtime.length === offer.runtime.length && measurements.length === offer.measurements.length
    ? offer
    : { ...offer, runtime, measurements };
}

function sourceStillContributes(model: Model, sourceId: string): boolean {
  if (model.aliases.some((alias) => alias.source_id === sourceId)) return true;
  if (model.evidence.some((item) => item.source_id === sourceId)) return true;
  if (model.benchmarks.some((item) => item.evidence.source_id === sourceId)) return true;
  if (model.reasoning.some((item) => item.source_id === sourceId || item.evidence.source_id === sourceId)) return true;
  if (model.pricing_observations.some((item) => item.evidence.source_id === sourceId)) return true;
  if (model.runtime_observations.some((item) => item.evidence.source_id === sourceId)) return true;
  if (model.measurements.some((item) => item.evidence.source_id === sourceId)) return true;
  return model.offers.some((offer) => offer.evidence.some((item) => item.source_id === sourceId)
    || Object.hasOwn(offer.source_projections ?? {}, sourceId)
    || offer.runtime.some((item) => item.evidence.source_id === sourceId)
    || offer.measurements.some((item) => item.evidence.source_id === sourceId));
}

function hasRetainedModelData(model: Model): boolean {
  return model.evidence.length > 0 || model.offers.length > 0 || model.benchmarks.length > 0
    || model.pricing_observations.length > 0 || model.runtime_observations.length > 0 || model.measurements.length > 0;
}

function redactModel(model: Model): Model | undefined {
  const next: Model = {
    ...model,
    aliases: model.aliases.filter((alias) => !isRestrictedPublicationName(alias.source_id)),
    reasoning: model.reasoning.filter((item) => !isRestrictedPublicationName(item.source_id) && !evidenceIsRestricted(item.evidence)),
    offers: model.offers.flatMap((item) => {
      const kept = redactOffer(item);
      return kept ? [kept] : [];
    }),
    benchmarks: model.benchmarks.filter((item) => !observationIsRestricted(item)),
    pricing_observations: model.pricing_observations.filter((item) => !evidenceIsRestricted(item.evidence)),
    runtime_observations: model.runtime_observations.filter((item) => !evidenceIsRestricted(item.evidence)),
    measurements: model.measurements.filter((item) => !evidenceIsRestricted(item.evidence)),
    evidence: model.evidence.filter((item) => !evidenceIsRestricted(item)),
  };
  if (!hasRetainedModelData(next)) return undefined;
  if (!next.metadata_by_source) return next;
  const projections = { ...next.metadata_by_source };
  let removed = false;
  for (const sourceId of Object.keys(projections)) {
    if (isRestrictedPublicationName(sourceId) || !sourceStillContributes(next, sourceId)) {
      delete projections[sourceId];
      removed = true;
    }
  }
  return removed ? applyMetadata(next, projections) : next;
}

/** Remove Artificial Analysis evidence. Scores are deleted, not rewritten to zero. */
export function redactRestrictedPublication(snapshot: Snapshot): Snapshot {
  const next = structuredClone(snapshot);
  if (publicationReview(next).evidence_count === 0) return next;
  next.benchmarks = next.benchmarks.filter((definition) => !definitionIsRestricted(definition));
  next.models = next.models.flatMap((model) => {
    const redacted = redactModel(model);
    return redacted ? [redacted] : [];
  });
  next.content_hash = contentHash(hashableSnapshot(next));
  validateSnapshot(next);
  return next;
}
