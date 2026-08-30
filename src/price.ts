import type { PricePoint, PriceUnit } from "./types.js";
import { asArray, asRecord, numberValue, stringValue } from "./utils.js";

type PriceSpec = { dimension: string; unit: PriceUnit };

const OPENROUTER_PRICE_SPECS: Record<string, PriceSpec> = {
  prompt: { dimension: "input", unit: "token" },
  completion: { dimension: "output", unit: "token" },
  input_cache_read: { dimension: "cache_read", unit: "token" },
  input_cache_write: { dimension: "cache_write", unit: "token" },
  input_cache_write_1h: { dimension: "cache_write_1h", unit: "token" },
  internal_reasoning: { dimension: "reasoning", unit: "token" },
  input_audio: { dimension: "audio_input", unit: "token" },
  output_audio: { dimension: "audio_output", unit: "token" },
  audio: { dimension: "audio_input", unit: "token" },
  audio_output: { dimension: "audio_output", unit: "token" },
  input_audio_cache: { dimension: "audio_cache_read", unit: "token" },
  image_token: { dimension: "image_input", unit: "token" },
  image: { dimension: "image", unit: "image" },
  image_output: { dimension: "image_output", unit: "image" },
  web_search: { dimension: "web_search", unit: "search" },
  request: { dimension: "request", unit: "request" },
};

function rounded(value: number): number {
  return Number(value.toPrecision(15));
}

function nonNegativePrice(value: unknown): number | undefined {
  const parsed = numberValue(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function point(spec: PriceSpec, raw: unknown, kind: PricePoint["kind"] = "fixed"): PricePoint {
  const rawValue = typeof raw === "number" || typeof raw === "string" ? raw : null;
  const parsed = nonNegativePrice(raw);
  const variable = stringValue(raw) === "-1" || parsed === undefined;
  return {
    dimension: spec.dimension,
    unit: spec.unit,
    amount_usd_per_unit: variable ? null : rounded(parsed),
    raw: rawValue,
    kind: variable ? "variable" : kind,
  };
}

export function normalizeOpenRouterPricing(pricing: unknown, modelId?: string): PricePoint[] {
  const input = asRecord(pricing);
  const prices: PricePoint[] = [];
  for (const [key, value] of Object.entries(input)) {
    // The API's rates already include discounts; this is a fraction, not a fee.
    if (key === "overrides" || key === "discount" || value === null || value === undefined) continue;
    const spec = OPENROUTER_PRICE_SPECS[key] ?? { dimension: key, unit: "unknown" as const };
    prices.push(point(spec, value));
  }
  const overrides = asArray(input.overrides).map((override, index) => {
    const value = asRecord(override);
    for (const key of Object.keys(value)) {
      if (!(key in OPENROUTER_PRICE_SPECS) && !["min_prompt_tokens", "utc_days", "utc_start", "utc_end"].includes(key)) {
        throw new Error(`unsupported OpenRouter pricing override field: ${key}`);
      }
    }
    const threshold = numberValue(value.min_prompt_tokens);
    if (value.min_prompt_tokens !== undefined && (!Number.isSafeInteger(threshold) || threshold! < 0 || threshold! >= Number.MAX_SAFE_INTEGER)) throw new Error("invalid OpenRouter min_prompt_tokens override");
    return { value, index, min: threshold === undefined ? 0 : threshold + 1,
      timed: ["utc_days", "utc_start", "utc_end"].some((key) => value[key] !== undefined && value[key] !== null) };
  });
  // The upstream threshold is strictly greater-than. Convert context-only
  // overrides into disjoint ranges, respecting last-match-wins per price key.
  for (const [key, spec] of Object.entries(OPENROUTER_PRICE_SPECS)) {
    const relevant = overrides.filter((entry) => !entry.timed && entry.value[key] !== undefined && entry.value[key] !== null);
    const boundaries = [...new Set(relevant.map((entry) => entry.min))].sort((a, b) => a - b);
    for (let index = 0; index < boundaries.length; index += 1) {
      const min = boundaries[index];
      const chosen = relevant.filter((entry) => entry.min <= min).at(-1)!;
      prices.push({ ...point(spec, chosen.value[key]), kind: "tiered",
        tier: { type: "context", min, ...(boundaries[index + 1] === undefined ? {} : { max: boundaries[index + 1] }) },
        override_index: chosen.index,
      });
    }
  }
  for (const override of overrides.filter((entry) => entry.timed)) {
    const record = override.value;
    const schedule = {
      utc_days: Array.isArray(record.utc_days) ? record.utc_days.filter((day): day is string => typeof day === "string") : undefined,
      utc_start: numberValue(record.utc_start),
      utc_end: numberValue(record.utc_end),
    };
    for (const [key, value] of Object.entries(record)) {
      const spec = OPENROUTER_PRICE_SPECS[key];
      if (!spec || value === undefined || value === null) continue;
      // A later context-only override shadows this scheduled price from its
      // threshold onward. Other price keys retain their own schedules.
      const shadowFrom = Math.min(...overrides.filter((entry) => !entry.timed && entry.index > override.index
        && entry.value[key] !== undefined && entry.value[key] !== null).map((entry) => entry.min));
      if (shadowFrom <= override.min) continue;
      prices.push({ ...point(spec, value, "scheduled"), kind: "scheduled", schedule,
        ...(override.min === 0 && !Number.isFinite(shadowFrom) ? {} : {
          tier: { type: "context", min: override.min, ...(Number.isFinite(shadowFrom) ? { max: shadowFrom } : {}) },
        }), override_index: override.index });
    }
  }
  return withCacheWriteBilling(prices, cacheWriteBilling(modelId, "openrouter")).sort(comparePrices);
}

export function normalizeMillionPricing(cost: unknown, billing?: PricePoint["cache_write_billing"]): PricePoint[] {
  const input = asRecord(cost);
  const names: Record<string, string> = {
    input: "input",
    output: "output",
    cache_read: "cache_read",
    cache_write: "cache_write",
    reasoning: "reasoning",
    input_audio: "audio_input",
    output_audio: "audio_output",
    image: "image",
    request: "request",
  };
  const prices: PricePoint[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (key === "tiers" || key === "context_over_200k" || key === "currency") continue;
    const dimension = names[key];
    if (!dimension) continue;
    const parsed = nonNegativePrice(value);
    prices.push({
      dimension,
      unit: key === "request" ? "request" : key === "image" ? "image" : "million_tokens",
      amount_usd_per_unit: parsed === undefined ? null : rounded(parsed),
      raw: typeof value === "number" || typeof value === "string" ? value : null,
      kind: parsed === undefined ? "variable" : "fixed",
    });
  }
  for (const tier of asArray(input.tiers)) {
    const record = asRecord(tier);
    const tierMeta = asRecord(record.tier);
    const type = tierMeta.type === "volume" ? "volume" : "context";
    const min = numberValue(tierMeta.size ?? tierMeta.min);
    const max = numberValue(tierMeta.max);
    for (const [key, value] of Object.entries(record)) {
      if (key === "tier") continue;
      const dimension = names[key];
      if (!dimension) continue;
      const parsed = nonNegativePrice(value);
      prices.push({
        dimension,
        unit: key === "request" ? "request" : key === "image" ? "image" : "million_tokens",
        amount_usd_per_unit: parsed === undefined ? null : rounded(parsed),
        raw: typeof value === "number" || typeof value === "string" ? value : null,
        kind: "tiered",
        tier: { type, min, ...(max === undefined ? {} : { max }) },
      });
    }
  }
  const longContext = asRecord(input.context_over_200k);
  if (Object.keys(longContext).length > 0) {
    for (const [key, value] of Object.entries(longContext)) {
      const dimension = names[key];
      if (!dimension) continue;
      // Explicit ranges supersede Models.dev's legacy 200k compatibility field.
      if (prices.some((price) => price.dimension === dimension && price.kind === "tiered")) continue;
      const parsed = nonNegativePrice(value);
      prices.push({
        dimension,
        unit: "million_tokens",
        amount_usd_per_unit: parsed === undefined ? null : rounded(parsed),
        raw: typeof value === "number" || typeof value === "string" ? value : null,
        kind: "tiered",
        tier: { type: "context", min: 200_000 },
      });
    }
  }
  return withCacheWriteBilling(prices, billing).sort(comparePrices);
}

export function cacheWriteBilling(modelId: string | undefined, sourceId: string): PricePoint["cache_write_billing"] {
  if (/^anthropic\/claude-/i.test(modelId ?? "")) return "full_rate";
  if (sourceId === "openrouter" && /^google\/gemini-/i.test(modelId ?? "")) return "surcharge";
  return undefined;
}

function withCacheWriteBilling(prices: PricePoint[], billing: PricePoint["cache_write_billing"]): PricePoint[] {
  return billing ? prices.map((price) => price.dimension.startsWith("cache_write") ? { ...price, cache_write_billing: billing } : price) : prices;
}

export function normalizePortkeyPricing(pricing: unknown): PricePoint[] {
  const root = asRecord(pricing);
  const config = asRecord(root.pricing_config ?? root);
  const payg = asRecord(config.pay_as_you_go);
  const prices: PricePoint[] = [];
  const map: Record<string, string> = {
    request_token: "input",
    response_token: "output",
    cache_write_input_token: "cache_write",
    cache_read_input_token: "cache_read",
  };
  for (const [key, dimension] of Object.entries(map)) {
    const raw = asRecord(payg[key]).price;
    if (raw === undefined) continue;
    const parsed = nonNegativePrice(raw);
    prices.push({
      dimension,
      unit: "token",
      amount_usd_per_unit: parsed === undefined ? null : rounded(parsed / 100),
      raw: typeof raw === "number" || typeof raw === "string" ? raw : null,
      kind: parsed === undefined ? "variable" : "fixed",
    });
  }
  return prices.sort(comparePrices);
}

function comparePrices(a: PricePoint, b: PricePoint): number {
  return `${a.dimension}:${a.kind}:${a.unit}:${JSON.stringify(a.tier ?? {})}:${JSON.stringify(a.schedule ?? {})}`
    .localeCompare(`${b.dimension}:${b.kind}:${b.unit}:${JSON.stringify(b.tier ?? {})}:${JSON.stringify(b.schedule ?? {})}`);
}
