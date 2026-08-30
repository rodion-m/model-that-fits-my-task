interface Price {
  dimension: string;
  unit: string;
  kind: string;
  amount_usd_per_unit: number | null;
  tier?: { type: string; min?: number; max?: number };
  cache_write_billing?: "full_rate" | "surcharge";
}
interface Workload {
  id?: string;
  description?: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_ratio: number;
  requests_per_task: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
}
export interface CostResult {
  estimated_cost_usd: number | null;
  missing_dimensions: string[];
  components: Record<string, number | null>;
  inputs: {
    input_tokens: number; output_tokens: number; cached_input_tokens: number;
    uncached_input_tokens: number; cache_write_tokens: number; reasoning_tokens: number;
    requests_per_task: number; context_tokens: number;
  };
}
export function estimateCost(offer: { pricing: Price[] }, profile: Workload): number | null;
export function estimateWorkloadCost(offer: { pricing: Price[] }, profile: Workload): CostResult;
export function workloadCompatibility(offer: { context_tokens?: number; max_output_tokens?: number }, profile: Workload): { status: "compatible" | "incompatible" | "unknown"; reasons: string[] };
export function validateWorkload(profile: Workload): void;
