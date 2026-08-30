export function estimateCost(offer, profile) {
  return estimateWorkloadCost(offer, profile).estimated_cost_usd;
}

export function estimateWorkloadCost(offer, profile) {
  validateWorkload(profile);
  const cachedInputTokens = profile.input_tokens * profile.cached_input_ratio;
  const cacheWriteTokens = profile.cache_write_tokens ?? 0;
  const uncachedInputTokens = profile.input_tokens - cachedInputTokens - cacheWriteTokens;
  const reasoningTokens = profile.reasoning_tokens ?? 0;
  const inputs = {
    input_tokens: profile.input_tokens, output_tokens: profile.output_tokens,
    cached_input_tokens: cachedInputTokens, uncached_input_tokens: uncachedInputTokens,
    cache_write_tokens: cacheWriteTokens, reasoning_tokens: reasoningTokens,
    requests_per_task: profile.requests_per_task, context_tokens: profile.input_tokens,
  };
  const missing = new Set();
  const components = {};
  if (cachedInputTokens > 0 && profile.cache_write_tokens === undefined) missing.add("cache_write_tokens");

  const add = (dimension, units) => {
    if (units <= 0) return;
    const rate = rateFor(offer.pricing ?? [], dimension, profile.input_tokens);
    if (rate === undefined || rate === "ambiguous") {
      missing.add(dimension);
      if (rate === "ambiguous" && dimension !== "request") missing.add(`${dimension}_tier`);
      components[dimension] = null;
      return;
    }
    const cost = rate * units * profile.requests_per_task;
    if (!Number.isFinite(cost)) {
      missing.add("cost_overflow");
      components[dimension] = null;
    } else components[dimension] = precise(cost);
  };
  let chargedInputTokens = uncachedInputTokens;
  if (cacheWriteTokens > 0) {
    const points = applicablePrices(offer.pricing ?? [], "cache_write", profile.input_tokens);
    const modes = new Set(Array.isArray(points) ? points.map((point) => point.cache_write_billing) : []);
    if (modes.size === 1 && modes.has("surcharge")) chargedInputTokens += cacheWriteTokens;
    else if (!(modes.size === 1 && modes.has("full_rate"))) missing.add("cache_write_billing");
  }
  add("input", chargedInputTokens);
  add("cache_read", cachedInputTokens);
  add("cache_write", cacheWriteTokens);
  add("output", profile.output_tokens);
  add("reasoning", reasoningTokens);
  if ((offer.pricing ?? []).some((point) => point.dimension === "request")) add("request", 1);
  const total = Object.values(components).reduce((sum, value) => sum + (value ?? 0), 0);
  if (!Number.isFinite(total)) missing.add("cost_overflow");
  return {
    estimated_cost_usd: missing.size > 0 ? null : precise(total),
    missing_dimensions: [...missing].sort(), components, inputs,
  };
}

function rateFor(pricing, dimension, contextTokens) {
  const applicable = applicablePrices(pricing, dimension, contextTokens);
  if (applicable === "ambiguous") return applicable;
  if (applicable.length === 0 || applicable.some((point) => !Number.isFinite(point.amount_usd_per_unit) || point.amount_usd_per_unit < 0)) return undefined;
  const rates = applicable.map((point) => {
    if (dimension === "request") return point.unit === "request" ? point.amount_usd_per_unit : undefined;
    if (point.unit === "million_tokens") return point.amount_usd_per_unit / 1_000_000;
    return point.unit === "token" ? point.amount_usd_per_unit : undefined;
  });
  if (rates.some((rate) => rate === undefined)) return undefined;
  if (rates.some((rate) => Math.abs(rate - rates[0]) > Math.max(1e-15, Math.abs(rates[0]) * 1e-9))) return "ambiguous";
  return rates[0];
}

function applicablePrices(pricing, dimension, contextTokens) {
  const points = pricing.filter((point) => point.dimension === dimension
    && (point.tier?.type !== "context" || (contextTokens >= (point.tier.min ?? 0)
      && (point.tier.max === undefined || contextTokens < point.tier.max))));
  if (points.some((point) => point.kind === "scheduled" || (point.kind === "tiered" && point.tier?.type !== "context"))) return "ambiguous";
  const tiers = points.filter((point) => point.kind === "tiered"
    && contextTokens >= (point.tier.min ?? 0)
    && (point.tier.max === undefined || contextTokens < point.tier.max));
  const highestThreshold = Math.max(...tiers.map((point) => point.tier.min ?? 0));
  if (tiers.some((point) => point.tier.max !== undefined) && new Set(tiers.map((point) => point.tier.min ?? 0)).size > 1) return "ambiguous";
  return tiers.length > 0
    ? tiers.filter((point) => (point.tier.min ?? 0) === highestThreshold)
    : points.filter((point) => point.kind === "fixed" || point.kind === "variable");
}

export function workloadCompatibility(offer, profile) {
  validateWorkload(profile);
  const output = profile.output_tokens + (profile.reasoning_tokens ?? 0);
  const reasons = [];
  if (Number.isFinite(offer.context_tokens) && profile.input_tokens + output > offer.context_tokens) reasons.push("input plus output and reasoning tokens exceed route context");
  if (Number.isFinite(offer.max_output_tokens) && output > offer.max_output_tokens) reasons.push("output plus reasoning tokens exceed route output limit");
  if (reasons.length > 0) return { status: "incompatible", reasons };
  if (!Number.isFinite(offer.context_tokens)) reasons.push("route context limit is unknown");
  if (!Number.isFinite(offer.max_output_tokens) && output > 0) reasons.push("route output limit is unknown");
  return { status: reasons.length > 0 ? "unknown" : "compatible", reasons };
}

export function validateWorkload(profile) {
  for (const key of ["input_tokens", "output_tokens", "requests_per_task", "cache_write_tokens", "reasoning_tokens"]) {
    const value = profile[key];
    if (value === undefined && ["cache_write_tokens", "reasoning_tokens"].includes(key)) continue;
    if (!Number.isSafeInteger(value) || value < (key === "requests_per_task" ? 1 : 0)) throw new Error(`${key} must be a non-negative safe integer${key === "requests_per_task" ? " greater than zero" : ""}`);
  }
  if (!Number.isFinite(profile.cached_input_ratio) || profile.cached_input_ratio < 0 || profile.cached_input_ratio > 1) throw new Error("cached_input_ratio must be between 0 and 1");
  if (profile.input_tokens * profile.cached_input_ratio + (profile.cache_write_tokens ?? 0) > profile.input_tokens) throw new Error("cache-read plus cache-write tokens cannot exceed total input_tokens");
}

function precise(value) {
  return Number(value.toPrecision(12));
}
