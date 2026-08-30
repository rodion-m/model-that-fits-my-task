import { createHash } from "node:crypto";

// A benchmark name is a discovery key, not proof that independent sources
// used the same evaluation protocol or the same release of a rolling index.
export function comparisonLane(observation) {
  const conditions = {
    benchmark_id: observation.benchmark_id,
    source_id: observation.evidence?.source_id ?? null,
    metric: observation.metric ?? null,
    unit: observation.unit ?? null,
    variant: observation.variant ?? null,
    effort: observation.effort ?? null,
    evaluator: observation.evaluator ?? null,
    dataset_version: observation.dataset_version ?? null,
    configuration: stableValue(observation.configuration ?? {}),
  };
  const lane_id = createHash("sha256").update(JSON.stringify(conditions)).digest("hex").slice(0, 32);
  return { lane_id, conditions };
}

export function comparisonLaneId(observation) {
  return comparisonLane(observation).lane_id;
}

const LOWER_METRICS = new Set(["wer", "semantic_wer_mean", "semantic_wer_pooled", "word_error_rate", "character_error_rate", "cer", "brier_score"]);
const HIGHER_METRICS = new Set([
  "accuracy", "pass_rate", "pass_at_1", "pass_at_3", "pass_all_3", "all_pass_rate",
  "task_resolution_rate", "criteria_pass_rate", "weighted_pass_rate", "fully_resolved_rate",
  "almost_resolved_rate", "raw_pass_rate", "unified_value_f1", "f1", "precision", "recall",
  "perfect_transcript_rate", "transcript_success_rate", "task_success_rate", "canonical_token_entity_match",
  "elo", "trueskill_rating", "brier_index",
]);

export function scoreDirection(observation, requested) {
  const configuration = observation.configuration ?? {};
  const declarations = [configuration.score_direction, configuration.direction]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => {
      const normalized = String(value).toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
      if (["higher", "higher_is_better"].includes(normalized)) return "higher";
      if (["lower", "lower_is_better"].includes(normalized)) return "lower";
      throw new Error(`unknown score direction declaration: ${value}`);
    });
  const metric = String(observation.metric ?? "").toLowerCase();
  const inferred = LOWER_METRICS.has(metric) ? "lower" : HIGHER_METRICS.has(metric) ? "higher" : undefined;
  if (inferred) declarations.push(inferred);
  if (requested !== undefined && requested !== null) {
    if (!["higher", "lower"].includes(requested)) throw new Error("score direction must be higher or lower");
    declarations.push(requested);
  }
  const directions = new Set(declarations);
  if (directions.size > 1) throw new Error("conflicting score directions for this comparison lane");
  if (directions.size === 0) throw new Error("score direction is unknown; specify higher or lower explicitly");
  return [...directions][0];
}

export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]));
  }
  return value;
}
