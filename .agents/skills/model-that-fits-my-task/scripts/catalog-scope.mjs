export const EVIDENCE_STALE_MS = 36 * 60 * 60 * 1000;

export function isAvailabilityEvidence(item) {
  return item.source_id !== "portkey"
    && !(item.fields?.length > 0 && item.fields.every((field) => ["pricing", "prices", "cache_pricing"].includes(field)));
}

export function hasFreshEvidence(evidence, generatedAt) {
  const snapshotTime = typeof generatedAt === "number" ? generatedAt : Date.parse(generatedAt);
  return (evidence ?? []).some((item) => {
    if (item.status === "stale") return false;
    const fetchedAt = Date.parse(item.fetched_at);
    return Number.isFinite(fetchedAt) && fetchedAt <= snapshotTime && snapshotTime - fetchedAt <= EVIDENCE_STALE_MS;
  });
}

export function offerInAvailableScope(offer, generatedAt) {
  if (offer.status !== "active") return false;
  const snapshotTime = typeof generatedAt === "number" ? generatedAt : Date.parse(generatedAt);
  if (offer.expires_at && (!Number.isFinite(Date.parse(offer.expires_at)) || Date.parse(offer.expires_at) <= snapshotTime)) return false;
  return hasFreshEvidence((offer.evidence ?? []).filter(isAvailabilityEvidence), snapshotTime);
}
