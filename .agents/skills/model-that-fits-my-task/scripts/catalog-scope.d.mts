interface Evidence {
  source_id: string;
  fetched_at: string;
  status: string;
  fields?: string[];
}
export const EVIDENCE_STALE_MS: number;
export function isAvailabilityEvidence(evidence: Evidence): boolean;
export function hasFreshEvidence(evidence: Evidence[], generatedAt: string | number): boolean;
export function offerInAvailableScope(offer: { status: string; expires_at?: string; evidence: Evidence[] }, generatedAt: string | number): boolean;
