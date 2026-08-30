#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { DEFAULT_BASE, download } from "./download-snapshot.mjs";
import { qualityCostPareto } from "./quality-cost-pareto.mjs";
import { parsePositiveNumber, parseScoreDimension, scoreCandidates } from "./task-fit-score.mjs";
import { comparisonLane } from "./benchmark-semantics.mjs";
import { EVIDENCE_STALE_MS, offerInAvailableScope as isAvailableOffer } from "./catalog-scope.mjs";

export { scoreCandidates } from "./task-fit-score.mjs";
export { comparisonLane } from "./benchmark-semantics.mjs";

export function parseSelectionArgs(argv) {
  const options = {
    base: DEFAULT_BASE,
    cache: undefined,
    scope: "available",
    providers: [],
    efforts: [],
    quantizations: [],
    variants: [],
    capabilities: [],
    benchmarks: [],
    scoreDimensions: [],
    pareto: null,
    speedScope: "offer",
    profile: null,
    workload: {},
    minTaskFit: 0,
    coveragePenalty: 1,
    models: [],
    minContext: 0,
    limit: 25,
  };
  const repeatable = new Map([
    ["--provider", "providers"],
    ["--effort", "efforts"],
    ["--quantization", "quantizations"],
    ["--variant", "variants"],
    ["--capability", "capabilities"],
    ["--benchmark", "benchmarks"],
    ["--model", "models"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    const key = repeatable.get(flag);
    const value = argv[index + 1];
    if (flag === "--score") {
      if (!value) throw new Error("--score requires a value");
      options.scoreDimensions.push(parseScoreDimension(value));
      index += 1;
      continue;
    }
    if (key) {
      if (!value) throw new Error(`${flag} requires a value`);
      options[key].push(value.toLowerCase());
      index += 1;
      continue;
    }
    if (!["--base", "--cache", "--scope", "--min-context", "--limit", "--coverage-penalty", "--pareto", "--profile", "--speed-scope", "--min-task-fit", "--input-tokens", "--output-tokens", "--cached-input-ratio", "--cache-write-tokens", "--reasoning-tokens", "--requests-per-task"].includes(flag)) {
      throw new Error(`unknown argument: ${flag}`);
    }
    if (!value) throw new Error(`${flag} requires a value`);
    if (flag === "--base") options.base = value.replace(/\/$/, "");
    if (flag === "--cache") options.cache = value;
    if (flag === "--scope") options.scope = value;
    if (flag === "--min-context") options.minContext = parseInteger(value, flag, 0);
    if (flag === "--limit") options.limit = parseInteger(value, flag, 1);
    if (flag === "--coverage-penalty") options.coveragePenalty = parsePositiveNumber(value, flag);
    if (flag === "--pareto") options.pareto = value;
    if (flag === "--profile") options.profile = value;
    if (flag === "--speed-scope") options.speedScope = value;
    if (flag === "--min-task-fit") options.minTaskFit = parseRange(value, flag, 0, 100);
    if (flag === "--input-tokens") options.workload.input_tokens = parseInteger(value, flag, 0);
    if (flag === "--output-tokens") options.workload.output_tokens = parseInteger(value, flag, 0);
    if (flag === "--cached-input-ratio") options.workload.cached_input_ratio = parseRange(value, flag, 0, 1);
    if (flag === "--cache-write-tokens") options.workload.cache_write_tokens = parseInteger(value, flag, 0);
    if (flag === "--reasoning-tokens") options.workload.reasoning_tokens = parseInteger(value, flag, 0);
    if (flag === "--requests-per-task") options.workload.requests_per_task = parseInteger(value, flag, 1);
    index += 1;
  }
  if (!options.cache) throw new Error("--cache is required");
  if (!new Set(["available", "all"]).has(options.scope)) throw new Error("--scope must be available or all");
  if (options.pareto && !new Set(["quality-cost", "quality-cost-speed"]).has(options.pareto)) throw new Error("--pareto must be quality-cost or quality-cost-speed");
  if (!new Set(["offer", "model"]).has(options.speedScope)) throw new Error("--speed-scope must be offer or model");
  if (options.pareto && options.scoreDimensions.length === 0) throw new Error("--pareto requires at least one --score dimension");
  if (options.profile && Object.keys(options.workload).length > 0) throw new Error("--profile cannot be combined with custom workload fields");
  if (options.pareto && !options.profile && (options.workload.input_tokens === undefined || options.workload.output_tokens === undefined)) {
    throw new Error("--pareto requires --profile or both --input-tokens and --output-tokens");
  }
  return options;
}

export function selectCandidates(snapshot, options) {
  const components = modelComponents(snapshot.models);
  const exactRequestedIds = new Set(snapshot.models.map((model) => model.id.toLowerCase()).filter((id) => options.models.includes(id)));
  const generatedAt = Date.parse(snapshot.generated_at);
  const candidates = [];
  for (const records of components) {
    const canonical = chooseCanonical(records);
    const offers = records.filter((model) => sameRelease(model, canonical)).flatMap((model) => model.offers ?? []);
    const matchingOffers = offers.filter((offer) => offerMatches(offer, options, generatedAt));
    const availableOffers = offers.filter((offer) => isAvailableOffer(offer, generatedAt));
    if (options.scope === "available" && !isAvailable(records, availableOffers)) continue;
    if (hasOfferFilters(options) && matchingOffers.length === 0) continue;
    if (options.models.length > 0 && !matchesModel(records, options.models, exactRequestedIds)) continue;

    const observations = [];
    let incompatibleObservationCount = 0;
    for (const record of records) for (const observation of record.benchmarks ?? []) {
      if (options.benchmarks.length > 0 && !options.benchmarks.includes(observation.benchmark_id.toLowerCase())) continue;
      if (!sameRelease(record, canonical)) {
        incompatibleObservationCount += 1;
        continue;
      }
      observations.push({
        ...observation,
        ...comparisonLane(observation),
        identity_record_id: record.id,
        identity_release_date: record.release_date ?? null,
      });
    }
    if (options.benchmarks.length > 0 && observations.length === 0) continue;
    candidates.push({
      canonical_model_id: canonical.id,
      name: canonical.name,
      release_date: canonical.release_date ?? null,
      record_ids: records.map((model) => model.id).sort(),
      matching_offers: matchingOffers.map(compactOffer),
      observations,
      runtime_observations: canonical.runtime_observations ?? [],
      incompatible_observation_count: incompatibleObservationCount,
    });
  }
  const scoring = scoreCandidates(candidates, options.scoreDimensions ?? [], options.coveragePenalty ?? 1);
  const pareto = options.pareto ? qualityCostPareto(candidates, snapshot, options) : null;
  candidates.sort((left, right) => {
    if (scoring) {
      const scoreOrder = (right.task_fit?.aggregate_score ?? -1) - (left.task_fit?.aggregate_score ?? -1);
      if (scoreOrder !== 0) return scoreOrder;
      const confidenceOrder = (right.task_fit?.confidence ?? -1) - (left.task_fit?.confidence ?? -1);
      if (confidenceOrder !== 0) return confidenceOrder;
    }
    return String(right.release_date ?? "").localeCompare(String(left.release_date ?? ""))
      || left.canonical_model_id.localeCompare(right.canonical_model_id);
  });
  return {
    data: candidates.slice(0, options.limit),
    ...(pareto ? {
      pareto_front: pareto.front.slice(0, options.limit),
      pareto_unranked: pareto.unranked.slice(0, options.limit),
    } : {}),
    meta: {
      total: candidates.length,
      limit: options.limit,
      scope: options.scope,
      evidence_max_age_hours: EVIDENCE_STALE_MS / 3_600_000,
      generated_at: snapshot.generated_at,
      content_hash: snapshot.content_hash,
      scoring,
      ...(pareto ? { pareto: pareto.meta } : {}),
    },
  };
}

function modelComponents(models) {
  const parent = models.map((_, index) => index);
  const byId = new Map(models.map((model, index) => [model.id.toLowerCase(), index]));
  const root = (index) => parent[index] === index ? index : (parent[index] = root(parent[index]));
  const join = (left, right) => {
    const leftRoot = root(left);
    const rightRoot = root(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  models.forEach((model, index) => {
    for (const alias of model.aliases ?? []) {
      const target = byId.get(String(alias.id).toLowerCase());
      // Unknown release dates cannot bridge otherwise distinct releases.
      if (target !== undefined && sameRelease(model, models[target])) join(index, target);
    }
  });
  const groups = new Map();
  models.forEach((model, index) => {
    const key = root(index);
    const group = groups.get(key) ?? [];
    group.push(model);
    groups.set(key, group);
  });
  return [...groups.values()];
}

function chooseCanonical(records) {
  return [...records].sort((left, right) => canonicalRank(right) - canonicalRank(left) || left.id.localeCompare(right.id))[0];
}

function canonicalRank(model) {
  const active = (model.offers ?? []).filter((offer) => offer.status === "active").length;
  const identity = model.identity_confidence === "exact" ? 2 : model.identity_confidence === "alias" ? 1 : 0;
  const variantPenalty = /:batch$|:\w+$|\/.*(?:-free|-latest)$/.test(model.id) ? 1 : 0;
  return active * 100 + identity * 10 + Math.min(model.benchmarks?.length ?? 0, 9) - variantPenalty;
}

function isAvailable(records, availableOffers) {
  if (availableOffers.length === 0) return false;
  if (!records.some((model) => model.identity_confidence !== "unresolved")) return false;
  return true;
}

function hasOfferFilters(options) {
  return options.providers.length > 0 || options.efforts.length > 0 || options.quantizations.length > 0
    || (options.variants ?? []).length > 0 || options.capabilities.length > 0 || options.minContext > 0;
}

function offerMatches(offer, options, generatedAt) {
  if (options.scope === "available" ? !isAvailableOffer(offer, generatedAt) : offer.status !== "active") return false;
  if (options.providers.length > 0 && !options.providers.includes(String(offer.provider_id).toLowerCase())) return false;
  if (options.efforts.length > 0 && !options.efforts.some((effort) => (offer.reasoning_efforts ?? []).map((value) => value.toLowerCase()).includes(effort))) return false;
  if (options.quantizations.length > 0 && !options.quantizations.includes(String(offer.quantization ?? "").toLowerCase())) return false;
  if ((options.variants ?? []).length > 0 && !options.variants.includes(String(offer.variant ?? "default").toLowerCase())) return false;
  if (options.minContext > 0 && (offer.context_tokens ?? 0) < options.minContext) return false;
  return options.capabilities.every((capability) =>
    offer.capabilities?.[capability] === true
      || (capability === "reasoning" && (offer.reasoning_efforts?.length ?? 0) > 0)
      || offer.supported_parameters?.some((parameter) => parameter.toLowerCase() === capability));
}

function matchesModel(records, requested, exactRequestedIds) {
  const ids = new Set(records.map((model) => model.id.toLowerCase()));
  const names = new Set(records.flatMap((model) => [model.id, ...(model.aliases ?? []).map((alias) => alias.id)]).map((id) => id.toLowerCase()));
  return requested.some((id) => exactRequestedIds.has(id) ? ids.has(id) : names.has(id));
}

function sameRelease(record, canonical) {
  if (record.id === canonical.id) return true;
  if (!record.release_date || !canonical.release_date) return false;
  return String(record.release_date).slice(0, 10) === String(canonical.release_date).slice(0, 10);
}

function compactOffer(offer) {
  return {
    id: offer.id,
    provider_id: offer.provider_id,
    provider_model_id: offer.provider_model_id,
    variant: offer.variant ?? null,
    expires_at: offer.expires_at ?? null,
    quantization: offer.quantization ?? null,
    context_tokens: offer.context_tokens ?? null,
    max_output_tokens: offer.max_output_tokens ?? null,
    capabilities: offer.capabilities,
    reasoning_efforts: offer.reasoning_efforts,
    supported_parameters: offer.supported_parameters,
    pricing: offer.pricing,
    runtime: offer.runtime,
    data_policy: offer.data_policy ?? null,
    evidence: offer.evidence,
  };
}

function parseInteger(value, name, minimum) {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${name} must be a safe decimal integer >= ${minimum}`);
  return parsed;
}

function parseRange(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) || !Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be a finite number between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function usage() {
  return "Usage: node scripts/select-models.mjs --cache <directory> [--scope available|all] [--provider id] [--effort level] [--quantization type] [--variant name] [--capability name] [--min-context tokens] [--benchmark id] [--score benchmark-or-lane[=weight][:higher|lower]] [--pareto quality-cost|quality-cost-speed (--profile id | --input-tokens n --output-tokens n) [--speed-scope offer|model] [--min-task-fit 0..100]] [--coverage-penalty n] [--model id] [--limit n] [--base url]";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseSelectionArgs(process.argv.slice(2));
    if (options.help) console.log(usage());
    else {
      const bundle = await download({ base: options.base, out: options.cache });
      const snapshot = JSON.parse(await readFile(bundle.snapshot_path, "utf8"));
      const result = selectCandidates(snapshot, options);
      result.meta.bundle_reused = bundle.reused;
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exitCode = 1;
  }
}
