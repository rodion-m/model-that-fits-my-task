import type { BenchmarkObservation } from "./types.js";
export { comparisonLaneId, scoreDirection } from "../.agents/skills/model-that-fits-my-task/scripts/benchmark-semantics.mjs";

export type LaneFields = Pick<
  BenchmarkObservation,
  "benchmark_id" | "metric" | "unit" | "variant" | "effort" | "evaluator" | "dataset_version" | "configuration"
> & { evidence?: Pick<BenchmarkObservation["evidence"], "source_id"> };
