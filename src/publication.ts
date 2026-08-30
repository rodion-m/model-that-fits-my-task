import type { Snapshot } from "./types.js";

export function publicationReview(snapshot: Snapshot): { restricted_sources: string[]; evidence_count: number } {
  const sources = new Set<string>();
  let evidenceCount = 0;
  const restricted = (value: string): boolean => value.toLowerCase().replaceAll(/[-_]/g, "").startsWith("artificialanalysis");
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
