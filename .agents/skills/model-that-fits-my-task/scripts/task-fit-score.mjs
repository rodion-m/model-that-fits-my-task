import { scoreDirection } from "./benchmark-semantics.mjs";

export function scoreCandidates(candidates, requestedDimensions, coveragePenalty = 1) {
  if (requestedDimensions.length === 0) return null;
  const dimensions = resolveDimensions(candidates, requestedDimensions);
  const totalWeight = dimensions.reduce((sum, dimension) => sum + dimension.weight, 0);
  if (!Number.isFinite(totalWeight) || totalWeight <= 0 || dimensions.some((dimension) => !Number.isFinite(dimension.weight) || dimension.weight <= 0)) throw new Error("score weights must have a finite positive sum");
  if (!Number.isFinite(coveragePenalty) || coveragePenalty <= 0) throw new Error("coverage penalty must be finite and positive");
  const utilitiesByLane = new Map(dimensions.map((dimension) => [
    dimension.lane_id,
    scoreLane(candidates, dimension),
  ]));

  for (const candidate of candidates) {
    candidate.task_fit = scoreCandidate(candidate, dimensions, utilitiesByLane, totalWeight, coveragePenalty);
  }

  return {
    formula: "aggregate_score = weighted_mean(percentile_utility_present) * coverage^coverage_penalty",
    normalization: "tie-aware empirical percentile within each exact comparison lane",
    missing_evidence: "reduces coverage; it is not treated as measured zero performance",
    coverage_penalty: coveragePenalty,
    dimensions,
  };
}

export function parseScoreDimension(value) {
  const match = value.match(/^(.+?)(?:=([0-9]*\.?[0-9]+))?(?::(higher|lower))?$/i);
  if (!match) throw new Error("--score must be <benchmark-or-lane>[=<weight>][:higher|lower]");
  return {
    target: match[1].toLowerCase(),
    weight: match[2] === undefined ? 1 : parsePositiveNumber(match[2], "--score weight"),
    direction: match[3]?.toLowerCase(),
  };
}

export function parsePositiveNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a finite number > 0`);
  return parsed;
}

function resolveDimensions(candidates, requested) {
  const observations = candidates.flatMap((candidate) => candidate.observations);
  const resolved = requested.map((request) => resolveDimension(observations, request));
  const duplicate = resolved.find((dimension, index) => resolved.findIndex((other) => other.lane_id === dimension.lane_id) !== index);
  if (duplicate) throw new Error(`comparison lane ${duplicate.lane_id} is scored more than once`);
  return resolved;
}

function resolveDimension(observations, request) {
  const exactLane = observations.find((row) => row.lane_id === request.target);
  if (exactLane) return dimension(request, exactLane);
  const lanes = new Map(observations
    .filter((row) => row.benchmark_id.toLowerCase() === request.target.toLowerCase())
    .map((row) => [row.lane_id, row]));
  if (lanes.size === 0) throw new Error(`score target ${request.target} has no observations in the selected candidates`);
  if (lanes.size > 1) throw new Error(`score target ${request.target} spans ${lanes.size} comparison lanes; rerun with an exact lane_id`);
  return dimension(request, [...lanes.values()][0]);
}

function dimension(request, observation) {
  if (["aggregate", "claim"].includes(observation.kind)) throw new Error(`${observation.kind} scores are not independent ranking evidence`);
  return {
    lane_id: observation.lane_id,
    benchmark_id: observation.benchmark_id,
    weight: request.weight,
    direction: scoreDirection(observation, request.direction),
    effort: observation.effort ?? null,
    variant: observation.variant ?? null,
    configuration: observation.configuration ?? {},
  };
}

function scoreLane(candidates, dimension) {
  const cohort = candidates.flatMap((candidate) => {
    const matching = candidate.observations.filter((row) => row.lane_id === dimension.lane_id);
    for (const row of matching) {
      if (["aggregate", "claim"].includes(row.kind)) throw new Error(`${row.kind} scores are not independent ranking evidence`);
      scoreDirection(row, dimension.direction);
    }
    const observation = representativeObservation(matching);
    if (observation) scoreDirection(observation, dimension.direction);
    return observation && Number.isFinite(observation.value)
      ? [{ modelId: candidate.canonical_model_id, observation, value: observation.value }]
      : [];
  });
  const utilities = percentileUtilities(cohort.map((row) => row.value), dimension.direction);
  return new Map(cohort.map((row, index) => [row.modelId, {
    observation: row.observation,
    utility: utilities[index],
    cohort_size: cohort.length,
  }]));
}

function scoreCandidate(candidate, dimensions, utilitiesByLane, totalWeight, coveragePenalty) {
  let coveredWeight = 0;
  let weightedUtility = 0;
  let weightedConfidence = 0;
  const contributions = dimensions.map((dimension) => {
    const scored = utilitiesByLane.get(dimension.lane_id).get(candidate.canonical_model_id);
    if (!scored) return { ...dimension, status: "missing" };
    const evidenceConfidence = evidenceReliability(scored.observation.evidence?.status);
    const cohortConfidence = Math.min(1, Math.max(0, scored.cohort_size - 1) / 4);
    const weight = dimension.weight / totalWeight;
    coveredWeight += weight;
    weightedUtility += weight * scored.utility;
    weightedConfidence += weight * evidenceConfidence * cohortConfidence;
    return {
      ...dimension,
      status: "scored",
      raw_value: scored.observation.value,
      metric: scored.observation.metric ?? null,
      unit: scored.observation.unit ?? null,
      percentile_utility: round(scored.utility),
      cohort_size: scored.cohort_size,
      evidence_status: scored.observation.evidence?.status ?? "unknown",
      sample_count: scored.observation.sample_count ?? null,
      evidence: scored.observation.evidence,
      uncertainty_metrics: scored.observation.metrics ?? {},
    };
  });
  const coverage = coveredWeight;
  const observedScore = coveredWeight > 0 ? weightedUtility / coveredWeight : null;
  return {
    aggregate_score: observedScore === null ? null : round(observedScore * coverage ** coveragePenalty),
    observed_score: observedScore === null ? null : round(observedScore),
    coverage: round(coverage),
    confidence: round(coveredWeight > 0 ? coverage * weightedConfidence / coveredWeight : 0),
    confidence_basis: "heuristic evidence provenance and cohort size, not a statistical confidence level",
    contributions,
  };
}

function representativeObservation(observations) {
  return observations.filter((row) => Number.isFinite(row.value)).sort((left, right) =>
    evidenceReliability(right.evidence?.status) - evidenceReliability(left.evidence?.status)
      || String(right.evidence?.fetched_at ?? "").localeCompare(String(left.evidence?.fetched_at ?? ""))
      || String(left.evidence?.source_id ?? "").localeCompare(String(right.evidence?.source_id ?? "")))[0];
}

function percentileUtilities(values, direction) {
  if (values.length === 1) return [50];
  return values.map((value) => {
    const worse = values.filter((other) => direction === "lower" ? other > value : other < value).length;
    const tiedOthers = values.filter((other) => other === value).length - 1;
    return 100 * (worse + tiedOthers / 2) / (values.length - 1);
  });
}

function evidenceReliability(status) {
  if (status === "observed") return 1;
  if (status === "derived") return 0.7;
  if (status === "claimed") return 0.4;
  return 0.25;
}

function round(value) {
  return Math.round(value * 10_000) / 10_000;
}
