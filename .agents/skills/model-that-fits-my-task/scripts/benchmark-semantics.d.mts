export interface LaneObservation {
  benchmark_id: string;
  evidence?: { source_id: string };
  metric?: string;
  unit?: string;
  variant?: string;
  effort?: string;
  evaluator?: string;
  dataset_version?: string;
  configuration?: Record<string, number | string | boolean | null>;
}
export function comparisonLane(observation: LaneObservation): { lane_id: string; conditions: Record<string, unknown> };
export function comparisonLaneId(observation: LaneObservation): string;
export function scoreDirection(observation: LaneObservation, requested?: string): "higher" | "lower";
export function stableValue(value: unknown): unknown;
