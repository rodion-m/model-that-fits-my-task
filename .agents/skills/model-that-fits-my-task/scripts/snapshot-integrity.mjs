import { createHash } from "node:crypto";
import { stableValue } from "./benchmark-semantics.mjs";
import { validateWorkload } from "./workload-cost.mjs";

export function snapshotContentHash(snapshot) {
  const contents = {
    schema_version: snapshot.schema_version,
    workload_profiles: snapshot.workload_profiles,
    benchmarks: snapshot.benchmarks,
    models: snapshot.models,
  };
  return createHash("sha256").update(JSON.stringify(stableValue(contents))).digest("hex");
}

/** Validate the installed schema's required fields and semantic invariants, not a downloaded executable schema. */
export function assertSnapshotIntegrity(snapshot) {
  object(snapshot, "snapshot");
  oneOf(snapshot.schema_version, ["1.0"], "snapshot.schema_version");
  timestamp(snapshot.generated_at, "snapshot.generated_at");
  if (typeof snapshot.content_hash !== "string" || !/^[a-f0-9]{64}$/.test(snapshot.content_hash)) fail("snapshot.content_hash", "must be a SHA-256 hex digest");
  rows(snapshot.workload_profiles, "snapshot.workload_profiles", profile, "id");
  rows(snapshot.sources, "snapshot.sources", source, "source_id");
  rows(snapshot.benchmarks, "snapshot.benchmarks", benchmarkDefinition, "id");
  rows(snapshot.models, "snapshot.models", model, "id");
  if (snapshotContentHash(snapshot) !== snapshot.content_hash) throw new Error("snapshot content_hash mismatch");
}

function model(value, path) {
  object(value, path);
  string(value.id, `${path}.id`);
  metadata(value, path, true);
  rows(value.aliases, `${path}.aliases`, (alias, at) => {
    object(alias, at);
    string(alias.id, `${at}.id`);
    string(alias.source_id, `${at}.source_id`);
    optional(alias.kind, `${at}.kind`, string);
  });
  rows(value.reasoning, `${path}.reasoning`, (reasoning, at) => {
    object(reasoning, at);
    string(reasoning.source_id, `${at}.source_id`);
    nullableBoolean(reasoning.supported, `${at}.supported`);
    optional(reasoning.mandatory, `${at}.mandatory`, boolean);
    optional(reasoning.efforts, `${at}.efforts`, strings);
    optional(reasoning.controls, `${at}.controls`, strings);
    evidence(reasoning.evidence, `${at}.evidence`);
  });
  rows(value.offers, `${path}.offers`, offer, "id");
  rows(value.benchmarks, `${path}.benchmarks`, benchmark);
  rows(value.pricing_observations, `${path}.pricing_observations`, (observation, at) => {
    object(observation, at);
    rows(observation.pricing, `${at}.pricing`, price);
    evidence(observation.evidence, `${at}.evidence`);
  });
  rows(value.runtime_observations, `${path}.runtime_observations`, runtime);
  rows(value.measurements, `${path}.measurements`, measurement);
  rows(value.evidence, `${path}.evidence`, evidence);
  if (value.metadata_by_source !== undefined) dictionary(value.metadata_by_source, `${path}.metadata_by_source`, (entry, at) => metadata(entry, at, false));
}

function metadata(value, path, required) {
  object(value, path);
  const check = (key, validator) => required ? validator(value[key], `${path}.${key}`) : optional(value[key], `${path}.${key}`, validator);
  check("identity_confidence", (entry, at) => oneOf(entry, ["exact", "alias", "unresolved"], at));
  check("name", string);
  check("creators", strings);
  check("open_weights", nullableBoolean);
  check("modalities", (entry, at) => {
    object(entry, at);
    strings(entry.input, `${at}.input`);
    strings(entry.output, `${at}.output`);
  });
  check("capabilities", (entry, at) => dictionary(entry, at, nullableBoolean));
  for (const key of ["family", "release_date", "knowledge_cutoff", "license"]) optional(value[key], `${path}.${key}`, string);
  for (const key of ["context_tokens", "max_output_tokens"]) optional(value[key], `${path}.${key}`, integer);
}

function offer(value, path, nested = false) {
  object(value, path);
  for (const key of ["id", "provider_id", "provider_model_id"]) string(value[key], `${path}.${key}`);
  for (const key of ["provider_name", "variant", "quantization"]) optional(value[key], `${path}.${key}`, string);
  optional(value.expires_at, `${path}.expires_at`, date);
  oneOf(value.status, ["active", "absent", "unknown"], `${path}.status`);
  for (const key of ["context_tokens", "max_output_tokens"]) optional(value[key], `${path}.${key}`, integer);
  strings(value.supported_parameters, `${path}.supported_parameters`);
  strings(value.reasoning_efforts, `${path}.reasoning_efforts`);
  dictionary(value.capabilities, `${path}.capabilities`, nullableBoolean);
  optional(value.data_policy, `${path}.data_policy`, object);
  rows(value.pricing, `${path}.pricing`, price);
  rows(value.runtime, `${path}.runtime`, runtime);
  rows(value.measurements, `${path}.measurements`, measurement);
  rows(value.evidence, `${path}.evidence`, evidence);
  if (value.source_projections !== undefined) {
    if (nested) fail(path, "source projections cannot be recursive");
    dictionary(value.source_projections, `${path}.source_projections`, (entry, at) => offer(entry, at, true));
    for (const [sourceId, projection] of Object.entries(value.source_projections)) {
      if (!projection.evidence.length || projection.evidence.some((entry) => entry.source_id !== sourceId)) fail(`${path}.source_projections.${sourceId}`, "evidence must belong to the projection's source");
    }
  }
}

function price(value, path) {
  object(value, path);
  string(value.dimension, `${path}.dimension`);
  oneOf(value.unit, ["token", "million_tokens", "request", "image", "search", "second", "character", "unknown"], `${path}.unit`);
  oneOf(value.kind, ["fixed", "variable", "tiered", "scheduled"], `${path}.kind`);
  if (value.amount_usd_per_unit !== null) nonnegative(value.amount_usd_per_unit, `${path}.amount_usd_per_unit`);
  if (value.raw !== null && typeof value.raw !== "string" && !(typeof value.raw === "number" && Number.isFinite(value.raw))) fail(`${path}.raw`, "must be a string, finite number, or null");
  if (value.tier !== undefined) {
    object(value.tier, `${path}.tier`);
    oneOf(value.tier.type, ["context", "volume"], `${path}.tier.type`);
    optional(value.tier.min, `${path}.tier.min`, nonnegative);
    optional(value.tier.max, `${path}.tier.max`, nonnegative);
    if (value.tier.max !== undefined && value.tier.max <= (value.tier.min ?? 0)) fail(`${path}.tier`, "max must exceed min");
  }
  if (value.schedule !== undefined) {
    object(value.schedule, `${path}.schedule`);
    optional(value.schedule.utc_days, `${path}.schedule.utc_days`, strings);
    for (const key of ["utc_start", "utc_end"]) optional(value.schedule[key], `${path}.schedule.${key}`, (entry, at) => {
      integer(entry, at);
      if (entry > 2359 || entry % 100 > 59) fail(at, "must use UTC HHMM notation");
    });
  }
  optional(value.override_index, `${path}.override_index`, integer);
  optional(value.cache_write_billing, `${path}.cache_write_billing`, (entry, at) => oneOf(entry, ["full_rate", "surcharge"], at));
}

function runtime(value, path) {
  object(value, path);
  oneOf(value.scope, ["model", "offer"], `${path}.scope`);
  optional(value.window, `${path}.window`, string);
  for (const key of ["latency_seconds", "ttft_seconds", "throughput_tokens_per_second"]) optional(value[key], `${path}.${key}`, (entry, at) => dictionary(entry, at, nonnegative));
  optional(value.uptime_fraction, `${path}.uptime_fraction`, (entry, at) => dictionary(entry, at, (number, key) => bounded(number, key, 0, 1)));
  optional(value.metrics, `${path}.metrics`, metrics);
  evidence(value.evidence, `${path}.evidence`);
}

function measurement(value, path) {
  object(value, path);
  oneOf(value.kind, ["measurement"], `${path}.kind`);
  string(value.offer_id, `${path}.offer_id`);
  oneOf(value.status, ["pass", "fail", "partial", "unknown"], `${path}.status`);
  optional(value.workload_profile_id, `${path}.workload_profile_id`, string);
  optional(value.reasoning_config, `${path}.reasoning_config`, object);
  optional(value.sample_count, `${path}.sample_count`, integer);
  metrics(value.metrics, `${path}.metrics`);
  evidence(value.evidence, `${path}.evidence`);
}

function benchmark(value, path) {
  object(value, path);
  string(value.benchmark_id, `${path}.benchmark_id`);
  finite(value.value, `${path}.value`);
  optional(value.kind, `${path}.kind`, benchmarkKind);
  optional(value.source_benchmark_ids, `${path}.source_benchmark_ids`, strings);
  for (const key of ["metric", "unit", "variant", "effort", "evaluator", "dataset_version"]) optional(value[key], `${path}.${key}`, string);
  optional(value.sample_count, `${path}.sample_count`, integer);
  optional(value.metrics, `${path}.metrics`, metrics);
  optional(value.configuration, `${path}.configuration`, metrics);
  evidence(value.evidence, `${path}.evidence`);
}

function benchmarkDefinition(value, path) {
  object(value, path);
  string(value.id, `${path}.id`);
  optional(value.aliases, `${path}.aliases`, strings);
  optional(value.kind, `${path}.kind`, benchmarkKind);
  for (const key of ["name", "category", "description", "version", "updated_at", "dataset_type"]) optional(value[key], `${path}.${key}`, string);
  optional(value.year, `${path}.year`, integer);
  optional(value.url, `${path}.url`, url);
  evidence(value.evidence, `${path}.evidence`);
}

function evidence(value, path) {
  object(value, path);
  string(value.source_id, `${path}.source_id`);
  url(value.url, `${path}.url`);
  timestamp(value.fetched_at, `${path}.fetched_at`);
  oneOf(value.status, ["observed", "derived", "stale"], `${path}.status`);
  optional(value.fields, `${path}.fields`, strings);
  optional(value.derived_from, `${path}.derived_from`, strings);
  optional(value.note, `${path}.note`, string);
}

function source(value, path) {
  object(value, path);
  string(value.source_id, `${path}.source_id`);
  url(value.url, `${path}.url`);
  oneOf(value.status, ["ok", "error", "skipped"], `${path}.status`);
  timestamp(value.attempted_at, `${path}.attempted_at`);
  optional(value.last_success_at, `${path}.last_success_at`, timestamp);
  integer(value.record_count, `${path}.record_count`);
  integer(value.warning_count, `${path}.warning_count`);
  optional(value.error, `${path}.error`, string);
}

function profile(value, path) {
  object(value, path);
  string(value.id, `${path}.id`);
  string(value.description, `${path}.description`);
  for (const key of ["input_tokens", "output_tokens"]) integer(value[key], `${path}.${key}`);
  for (const key of ["cache_write_tokens", "reasoning_tokens"]) optional(value[key], `${path}.${key}`, integer);
  integer(value.requests_per_task, `${path}.requests_per_task`);
  if (value.requests_per_task < 1) fail(`${path}.requests_per_task`, "must be at least one");
  bounded(value.cached_input_ratio, `${path}.cached_input_ratio`, 0, 1);
  validateWorkload(value);
}

function fail(path, message) { throw new Error(`${path} ${message}`); }
function object(value, path) { if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "must be an object"); }
function string(value, path) { if (typeof value !== "string" || !value.trim()) fail(path, "must be a nonempty string"); }
function boolean(value, path) { if (typeof value !== "boolean") fail(path, "must be boolean"); }
function nullableBoolean(value, path) { if (value !== null) boolean(value, path); }
function finite(value, path) { if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "must be finite"); }
function nonnegative(value, path) { finite(value, path); if (value < 0) fail(path, "must be nonnegative"); }
function bounded(value, path, min, max) { finite(value, path); if (value < min || value > max) fail(path, `must be between ${min} and ${max}`); }
function integer(value, path) { if (!Number.isSafeInteger(value) || value < 0) fail(path, "must be a nonnegative safe integer"); }
function oneOf(value, allowed, path) { if (!allowed.includes(value)) fail(path, `must be one of ${allowed.join(", ")}`); }
function benchmarkKind(value, path) { oneOf(value, ["benchmark", "index", "aggregate", "claim"], path); }
function optional(value, path, validator) { if (value !== undefined) validator(value, path); }
function date(value, path) { string(value, path); if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) || !Number.isFinite(Date.parse(value))) fail(path, "must be an ISO date or timestamp"); }
function timestamp(value, path) { date(value, path); if (!value.includes("T") || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) fail(path, "must be a timestamp with a timezone"); }
function url(value, path) {
  string(value, path);
  try { const parsed = new URL(value); if (!["https:", "http:"].includes(parsed.protocol)) throw new Error(); }
  catch { fail(path, "must be an HTTP(S) URL"); }
}
function rows(value, path, validator, uniqueKey) {
  if (!Array.isArray(value)) fail(path, "must be an array");
  const seen = new Set();
  value.forEach((entry, index) => {
    const at = `${path}[${index}]`;
    validator(entry, at);
    if (uniqueKey) {
      if (seen.has(entry[uniqueKey])) fail(`${at}.${uniqueKey}`, "must be unique");
      seen.add(entry[uniqueKey]);
    }
  });
}
function strings(value, path) { rows(value, path, string); }
function dictionary(value, path, validator) {
  object(value, path);
  for (const [key, entry] of Object.entries(value)) { string(key, path); validator(entry, `${path}.${key}`); }
}
function metrics(value, path) {
  dictionary(value, path, (entry, at) => {
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return;
    finite(entry, at);
  });
}
