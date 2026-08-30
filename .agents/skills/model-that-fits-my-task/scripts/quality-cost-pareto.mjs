import { estimateWorkloadCost, workloadCompatibility } from "./workload-cost.mjs";

export function qualityCostPareto(candidates, snapshot, options) {
  const workload = resolveWorkload(snapshot.workload_profiles ?? [], options);
  const includesSpeed = options.pareto === "quality-cost-speed";
  const comparable = [];
  const unranked = [];
  let excludedBelowQualityFloor = 0;

  for (const candidate of candidates) {
    const quality = candidate.task_fit?.aggregate_score;
    if (!Number.isFinite(quality)) {
      const offers = candidate.matching_offers.length > 0 ? candidate.matching_offers : [null];
      for (const offer of offers) for (const effort of configurationsForOffer(offer, options.efforts)) {
        unranked.push(unrankedChoice(candidate, offer, effort, "quality score is unavailable"));
      }
      continue;
    }
    if (quality < options.minTaskFit) {
      excludedBelowQualityFloor += 1;
      continue;
    }
    for (const offer of candidate.matching_offers) {
      const cost = estimateWorkloadCost(offer, workload);
      const compatibility = workloadCompatibility(offer, workload);
      const speed = includesSpeed ? representativeSpeed(candidate, offer, options.speedScope) : null;
      for (const reasoningEffort of configurationsForOffer(offer, options.efforts)) {
        const transfer = qualityTransfer(candidate, offer, reasoningEffort);
        const choice = {
          canonical_model_id: candidate.canonical_model_id,
          name: candidate.name,
          offer_id: offer.id,
          provider_id: offer.provider_id,
          provider_model_id: offer.provider_model_id,
          variant: offer.variant ?? null,
          quantization: offer.quantization ?? null,
          reasoning_effort: reasoningEffort,
          quality_score: quality,
          quality_coverage: candidate.task_fit.coverage,
          quality_confidence: candidate.task_fit.confidence,
          quality_transfer: transfer,
          workload_compatibility: compatibility,
          estimated_cost_usd: cost.estimated_cost_usd,
          cost_components: cost.components,
          pricing_evidence: offer.evidence ?? [],
          ...(speed ?? {}),
        };
        if (transfer.status !== "exact" || compatibility.status !== "compatible") {
          unranked.push({ ...choice, unranked_reason: [...transfer.reasons, ...compatibility.reasons].join("; ") });
        } else if (cost.estimated_cost_usd === null) {
          unranked.push({ ...choice, unranked_reason: `cost is incomplete: ${cost.missing_dimensions.join(", ")}` });
        } else if (includesSpeed && speed === null) {
          unranked.push({ ...choice, unranked_reason: `speed is incomplete: median TTFT and TPS are required at ${options.speedScope} scope` });
        } else {
          comparable.push(choice);
        }
      }
    }
  }

  const byPreference = (left, right) => right.quality_score - left.quality_score
    || left.estimated_cost_usd - right.estimated_cost_usd
    || (includesSpeed ? left.ttft_seconds - right.ttft_seconds : 0)
    || (includesSpeed ? right.throughput_tokens_per_second - left.throughput_tokens_per_second : 0)
    || left.canonical_model_id.localeCompare(right.canonical_model_id)
    || left.offer_id.localeCompare(right.offer_id);
  const frontChoices = includesSpeed
    ? multiObjectiveFront(comparable, byPreference)
    : nonDominatedFront(comparable, byPreference);
  const front = groupEquivalentChoices(frontChoices, includesSpeed);
  unranked.sort((left, right) => left.canonical_model_id.localeCompare(right.canonical_model_id)
    || String(left.offer_id ?? "").localeCompare(String(right.offer_id ?? "")));

  return {
    front,
    unranked,
    meta: {
      mode: options.pareto,
      objective: includesSpeed
        ? "maximize task-fit quality and TPS; minimize estimated workload cost and TTFT"
        : "maximize task-fit quality and minimize estimated workload cost",
      dominance: includesSpeed
        ? "A dominates B when quality and TPS are no worse, cost and TTFT are no worse, and at least one objective is strictly better"
        : "A dominates B when quality(A) >= quality(B), cost(A) <= cost(B), and at least one inequality is strict",
      ...(includesSpeed ? { speed_scope: options.speedScope, speed_statistic: "median (p50 accepted as equivalent)" } : {}),
      quality_floor: options.minTaskFit,
      workload,
      comparable_choice_count: comparable.length,
      pareto_front_choice_count: frontChoices.length,
      pareto_point_count: front.length,
      excluded_model_count_below_quality_floor: excludedBelowQualityFloor,
      unranked_choice_count: unranked.length,
    },
  };
}

function groupEquivalentChoices(choices, includesSpeed) {
  const groups = new Map();
  for (const choice of choices) {
    const key = JSON.stringify([
      choice.canonical_model_id,
      choice.quality_score,
      choice.quality_coverage,
      choice.quality_confidence,
      choice.quality_transfer,
      choice.workload_compatibility,
      choice.estimated_cost_usd,
      ...(includesSpeed ? [choice.ttft_seconds, choice.throughput_tokens_per_second, choice.speed_scope] : []),
    ]);
    const group = groups.get(key) ?? [];
    group.push(choice);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group[0],
    equivalent_choice_count: group.length,
    equivalent_offers: group.map((choice) => ({
      canonical_model_id: choice.canonical_model_id,
      offer_id: choice.offer_id,
      provider_id: choice.provider_id,
      provider_model_id: choice.provider_model_id,
      variant: choice.variant,
      quantization: choice.quantization,
      reasoning_effort: choice.reasoning_effort,
      pricing_evidence: choice.pricing_evidence,
      ...(includesSpeed ? { speed_evidence: choice.speed_evidence, speed_window: choice.speed_window } : {}),
    })),
  }));
}

function representativeSpeed(candidate, offer, scope) {
  const observations = scope === "offer" ? offer.runtime ?? [] : candidate.runtime_observations ?? [];
  return observations.flatMap((observation) => {
    if (observation.scope !== scope) return [];
    const ttft = runtimeMetric(observation, "ttft");
    const throughput = runtimeMetric(observation, "throughput");
    if (!Number.isFinite(ttft) || ttft < 0 || !Number.isFinite(throughput) || throughput <= 0) return [];
    return [{
      ttft_seconds: ttft,
      throughput_tokens_per_second: throughput,
      speed_scope: scope,
      speed_window: observation.window ?? null,
      speed_evidence: observation.evidence,
    }];
  }).sort((left, right) => evidenceReliability(right.speed_evidence?.status) - evidenceReliability(left.speed_evidence?.status)
    || String(right.speed_evidence?.fetched_at ?? "").localeCompare(String(left.speed_evidence?.fetched_at ?? "")))[0] ?? null;
}

function runtimeMetric(observation, metric) {
  const series = metric === "ttft" ? observation.ttft_seconds : observation.throughput_tokens_per_second;
  const direct = series?.median ?? series?.p50;
  if (Number.isFinite(direct)) return Number(direct);
  const metrics = observation.metrics ?? {};
  const keys = metric === "ttft"
    ? ["median-time-to-first-token-seconds", "median_time_to_first_token_seconds"]
    : ["median-output-tokens-per-second", "median_output_tokens_per_second"];
  const value = keys.map((key) => metrics[key]).find(Number.isFinite);
  return value === undefined ? null : Number(value);
}

function resolveWorkload(profiles, options) {
  if (options.profile) {
    const profile = profiles.find((candidate) => candidate.id === options.profile);
    if (!profile) throw new Error(`workload profile ${options.profile} was not found in the snapshot`);
    return profile;
  }
  return {
    id: "custom",
    input_tokens: options.workload.input_tokens,
    output_tokens: options.workload.output_tokens,
    cached_input_ratio: options.workload.cached_input_ratio ?? 0,
    ...(options.workload.cache_write_tokens === undefined ? {} : { cache_write_tokens: options.workload.cache_write_tokens }),
    ...(options.workload.reasoning_tokens === undefined ? {} : { reasoning_tokens: options.workload.reasoning_tokens }),
    requests_per_task: options.workload.requests_per_task ?? 1,
  };
}


function nonDominatedFront(choices, ordering) {
  const sorted = [...choices].sort(ordering);
  const front = [];
  let lowestCost = Number.POSITIVE_INFINITY;
  let highestQualityAtLowestCost = Number.NEGATIVE_INFINITY;
  for (const choice of sorted) {
    const cheaperSeen = lowestCost < choice.estimated_cost_usd;
    const sameCostHigherQualitySeen = lowestCost === choice.estimated_cost_usd
      && highestQualityAtLowestCost > choice.quality_score;
    if (!cheaperSeen && !sameCostHigherQualitySeen) front.push(choice);
    if (choice.estimated_cost_usd < lowestCost) {
      lowestCost = choice.estimated_cost_usd;
      highestQualityAtLowestCost = choice.quality_score;
    } else if (choice.estimated_cost_usd === lowestCost) {
      highestQualityAtLowestCost = Math.max(highestQualityAtLowestCost, choice.quality_score);
    }
  }
  return front;
}

function multiObjectiveFront(choices, ordering) {
  const front = [];
  for (const choice of [...choices].sort(ordering)) {
    if (!front.some((other) => speedDominates(other, choice))) front.push(choice);
  }
  return front;
}

function speedDominates(left, right) {
  return left.quality_score >= right.quality_score
    && left.estimated_cost_usd <= right.estimated_cost_usd
    && left.ttft_seconds <= right.ttft_seconds
    && left.throughput_tokens_per_second >= right.throughput_tokens_per_second
    && (left.quality_score > right.quality_score
      || left.estimated_cost_usd < right.estimated_cost_usd
      || left.ttft_seconds < right.ttft_seconds
      || left.throughput_tokens_per_second > right.throughput_tokens_per_second);
}

function evidenceReliability(status) {
  if (status === "observed") return 1;
  if (status === "derived") return 0.7;
  if (status === "claimed") return 0.4;
  return 0.25;
}

function configurationsForOffer(offer, requestedEfforts) {
  if (!offer || requestedEfforts.length === 0) return [null];
  const supported = new Set((offer.reasoning_efforts ?? []).map((effort) => effort.toLowerCase()));
  return requestedEfforts.filter((effort) => supported.has(effort));
}

function qualityTransfer(candidate, offer, effort) {
  const incompatible = [];
  const unknown = [];
  for (const contribution of candidate.task_fit.contributions ?? []) {
    if (contribution.status !== "scored") continue;
    const evaluatedEffort = contribution.effort?.toLowerCase();
    if (effort && evaluatedEffort && effort !== evaluatedEffort) incompatible.push(`quality was evaluated at effort=${evaluatedEffort}, not ${effort}`);
    else if ((effort ?? null) !== (evaluatedEffort ?? null)) unknown.push("reasoning effort transfer is unverified");
    const evaluatedQuantization = contribution.configuration?.quantization?.toLowerCase?.();
    const offeredQuantization = offer.quantization?.toLowerCase();
    if (offeredQuantization && evaluatedQuantization && offeredQuantization !== evaluatedQuantization) incompatible.push(`quality was evaluated at quantization=${evaluatedQuantization}, not ${offeredQuantization}`);
    else if ((offeredQuantization ?? null) !== (evaluatedQuantization ?? null)) unknown.push("quantization impact on quality is unknown");
  }
  return { status: incompatible.length > 0 ? "incompatible" : unknown.length > 0 ? "unknown" : "exact", reasons: [...new Set([...incompatible, ...unknown])] };
}

function unrankedChoice(candidate, offer, reasoningEffort, reason) {
  return {
    canonical_model_id: candidate.canonical_model_id,
    name: candidate.name,
    offer_id: offer?.id ?? null,
    provider_id: offer?.provider_id ?? null,
    provider_model_id: offer?.provider_model_id ?? null,
    variant: offer?.variant ?? null,
    quantization: offer?.quantization ?? null,
    reasoning_effort: reasoningEffort,
    quality_score: candidate.task_fit?.aggregate_score ?? null,
    estimated_cost_usd: null,
    unranked_reason: reason,
  };
}
