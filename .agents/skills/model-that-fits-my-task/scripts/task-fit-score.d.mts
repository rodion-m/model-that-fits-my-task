export interface ScoreDimension { target: string; weight: number; direction?: string }
export function parseScoreDimension(value: string): ScoreDimension;
export function parsePositiveNumber(value: string, name: string): number;
export function scoreCandidates(candidates: Array<{ canonical_model_id: string; observations: Array<Record<string, unknown>> }>, dimensions: ScoreDimension[], coveragePenalty?: number): Record<string, unknown> | null;
