import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { clearSnapshotCache, loadArchiveSnapshot, loadSnapshot } from "../src/db.js";
import { canonicalModelId, splitRoutingVariant } from "../src/identity.js";
import { mergeSnapshots } from "../src/merge.js";
import { estimateWorkloadCost } from "../src/cost.js";
import { health, listFacets, listModels, listOffers, listBenchmarkObservations, QueryInputError } from "../src/query.js";
import { comparisonLaneId } from "../src/lane.js";
import { buildRuntimeQueryArtifact } from "../src/runtime-artifact.js";
import { normalizeMillionPricing } from "../src/price.js";
import type { BenchmarkObservation, Offer, SourceRecord, SourceResult } from "../src/types.js";

test("strict query parsing rejects unknown enums, malformed values, and bad sort keys", () => {
  const snapshot = fixtureSnapshot();
  assert.throws(() => listModels(snapshot, new URLSearchParams("scope=fresh")), (error: unknown) => {
    return error instanceof QueryInputError && error.parameter === "scope";
  });
  assert.throws(() => listModels(snapshot, new URLSearchParams("open_weights=yes")), (error: unknown) => {
    return error instanceof QueryInputError && error.parameter === "open_weights";
  });
  assert.throws(() => listModels(snapshot, new URLSearchParams("min_context=-1")), (error: unknown) => {
    return error instanceof QueryInputError && error.parameter === "min_context";
  });
  assert.throws(() => listModels(snapshot, new URLSearchParams("released_after=not-a-date")), (error: unknown) => {
    return error instanceof QueryInputError && error.parameter === "released_after";
  });
  assert.throws(() => listModels(snapshot, new URLSearchParams("released_after=2026-02-31")), (error: unknown) => {
    return error instanceof QueryInputError && error.parameter === "released_after";
  });
  assert.throws(() => listModels(snapshot, new URLSearchParams("sort=popularity")), (error: unknown) => {
    return error instanceof QueryInputError && error.parameter === "sort";
  });
  assert.throws(() => listOffers(snapshot, new URLSearchParams("has_runtime=maybe")), (error: unknown) => {
    return error instanceof QueryInputError && error.parameter === "has_runtime";
  });
  assert.throws(() => listModels(snapshot, new URLSearchParams("released_after=2026-08-01&released_before=2026-01-01")), (error: unknown) => {
    return error instanceof QueryInputError && error.parameter === "released_after";
  });
});

test("default scope is freshly available while scope=all keeps the complete catalog", () => {
  const available = sourceRecord("models_dev", "openai/gpt-4o", "GPT-4o", "offer-available");
  available.release_date = "2026-01-01";
  const historical = sourceRecord("models_dev", "openai/gpt-3", "GPT-3", "offer-old");
  historical.release_date = "2020-06-01";
  historical.offers![0].status = "absent";
  const unresolved = sourceRecord("epoch", "epoch:Mystery", "Mystery", "offer-unresolved");
  unresolved.id = "unresolved/epoch/mystery";
  unresolved.identity_confidence = "unresolved";
  unresolved.offers = [];
  const noOffer = sourceRecord("benchlm", "google/gemini-2-5-pro", "Gemini 2.5 Pro", "unused");
  noOffer.offers = [];
  noOffer.release_date = "2025-06-17";
  const snapshot = mergeSnapshots(undefined, [
    result("models_dev", [available, historical]),
    result("epoch", [unresolved]),
    result("benchlm", [noOffer]),
  ], "2026-08-26T00:00:00.000Z");

  const selected = listModels(snapshot, new URLSearchParams("view=summary"));
  assert.equal(selected.meta.scope, "available");
  assert.ok((selected.meta.excluded_count ?? 0) >= 2);
  assert.deepEqual(selected.data.map((row) => row.id), ["openai/gpt-4o"]);

  const all = listModels(snapshot, new URLSearchParams("scope=all&view=summary"));
  assert.equal(all.meta.scope, "all");
  assert.equal(all.meta.excluded_count, 0);
  assert.ok(all.data.some((row) => row.id === "openai/gpt-3"));
  assert.ok(all.data.some((row) => row.id.startsWith("unresolved/") || row.id === "unresolved/epoch/mystery"));

  const facets = listFacets(snapshot);
  assert.equal(facets.meta.scope, "available");
  const allFacets = listFacets(snapshot, new URLSearchParams("scope=all"));
  assert.equal(allFacets.meta.scope, "all");
  assert.ok((allFacets.capabilities.find((row) => row.value === "tools")?.model_count ?? 0) >= (facets.capabilities.find((row) => row.value === "tools")?.model_count ?? 0));

  const offers = listOffers(snapshot, new URLSearchParams());
  assert.equal(offers.meta.scope, "available");
  assert.ok((offers.meta.excluded_count ?? 0) >= 1);
  assert.equal(listOffers(snapshot, new URLSearchParams("scope=all")).meta.excluded_count, 0);

  const status = health(snapshot);
  assert.equal(status.default_scope, "available");
  assert.equal(status.available_model_count, 1);
  assert.equal(status.all_model_count, snapshot.models.length);
  assert.equal(status.content_hash, snapshot.content_hash);

  const unknownRelease = sourceRecord("models_dev", "vendor/unknown-release", "Unknown release", "unknown-release");
  delete unknownRelease.release_date;
  unknownRelease.evidence![0].fetched_at = "2026-08-26T00:00:00.000Z";
  unknownRelease.offers![0].evidence[0].fetched_at = "2026-08-26T00:00:00.000Z";
  const unknownSnapshot = mergeSnapshots(undefined, [result("models_dev", [unknownRelease])], "2026-08-26T00:00:00.000Z");
  assert.equal(listModels(unknownSnapshot, new URLSearchParams("view=summary")).data.length, 1);
  assert.equal(listModels(unknownSnapshot, new URLSearchParams("scope=all&view=summary")).data.length, 1);
});

test("sort=released orders by release date and released_after/before are explicit filters", () => {
  const older = sourceRecord("models_dev", "openai/gpt-4o", "GPT-4o", "a");
  older.release_date = "2025-10-01";
  older.evidence![0].fetched_at = "2026-08-25T00:00:00.000Z";
  older.offers![0].evidence[0].fetched_at = "2026-08-25T00:00:00.000Z";
  const newer = sourceRecord("models_dev", "openai/gpt-5", "GPT-5", "b");
  newer.release_date = "2026-08-01";
  newer.evidence![0].fetched_at = "2026-08-26T00:00:00.000Z";
  newer.offers![0].evidence[0].fetched_at = "2026-08-26T00:00:00.000Z";
  const snapshot = mergeSnapshots(undefined, [result("models_dev", [older, newer])], "2026-08-26T00:00:00.000Z");
  const sorted = listModels(snapshot, new URLSearchParams("sort=released&view=summary"));
  assert.deepEqual(sorted.data.map((row) => row.id), ["openai/gpt-5", "openai/gpt-4o"]);
  assert.equal(listModels(snapshot, new URLSearchParams("released_after=2026-01-01&view=summary")).data[0]?.id, "openai/gpt-5");
  assert.equal(listModels(snapshot, new URLSearchParams("released_before=2026-01-01&view=summary")).data[0]?.id, "openai/gpt-4o");
  assert.deepEqual(listModels(snapshot, new URLSearchParams("sort=updated&view=summary")).data.map((row) => row.id), ["openai/gpt-5", "openai/gpt-4o"]);
});

test("available scope ignores model age but rejects stale and expired offers", () => {
  const oldButAvailable = sourceRecord("models_dev", "vendor/old-but-available", "Old but available", "available");
  oldButAvailable.release_date = "2020-01-01";
  const stale = sourceRecord("models_dev", "vendor/stale", "Stale", "stale");
  stale.offers![0].evidence[0].fetched_at = "2026-08-20T00:00:00.000Z";
  const expired = sourceRecord("models_dev", "vendor/expired", "Expired", "expired");
  expired.offers![0].expires_at = "2026-08-26T00:00:00.000Z";
  const snapshot = mergeSnapshots(undefined, [result("models_dev", [oldButAvailable, stale, expired])], "2026-08-27T00:00:00.000Z");

  assert.deepEqual(listModels(snapshot, new URLSearchParams("view=summary")).data.map((row) => row.id), ["vendor/old-but-available"]);
  assert.equal(listModels(snapshot, new URLSearchParams("scope=all&view=summary")).data.length, 3);
});

test("provider plus capability or context constraints cannot match across two different offers", () => {
  const record = sourceRecord("models_dev", "openai/gpt-4o", "GPT-4o", "tools-offer");
  record.offers![0].provider_id = "openai";
  record.offers![0].capabilities = { tools: true };
  record.offers![0].context_tokens = 8_000;
  record.offers!.push({
    ...record.offers![0],
    id: "big-context",
    provider_id: "openrouter",
    capabilities: { tools: false },
    context_tokens: 200_000,
    supported_parameters: [],
  });
  const snapshot = mergeSnapshots(undefined, [result("models_dev", [record])], "2026-08-26T00:00:00.000Z");
  assert.equal(listModels(snapshot, new URLSearchParams("provider=openai&capability=tools&view=summary")).data.length, 1);
  assert.equal(listModels(snapshot, new URLSearchParams("provider=openrouter&capability=tools&view=summary")).data.length, 0);
  assert.equal(listModels(snapshot, new URLSearchParams("provider=openai&min_context=100000&view=summary")).data.length, 0);
  assert.equal(listModels(snapshot, new URLSearchParams("provider=openrouter&min_context=100000&view=summary")).data.length, 1);

  const modelOnlyClaim = sourceRecord("models_dev", "vendor/model-only-tools", "Model-only tools", "model-only");
  modelOnlyClaim.capabilities = { tools: true };
  modelOnlyClaim.offers![0].capabilities = { tools: false };
  const modelOnlySnapshot = mergeSnapshots(undefined, [result("models_dev", [modelOnlyClaim])], "2026-08-26T00:00:00.000Z");
  assert.equal(listModels(modelOnlySnapshot, new URLSearchParams("capability=tools&view=summary")).data.length, 0);
});

test("punctuation and batch aliases join without merging dated versions or families", () => {
  assert.equal(canonicalModelId({ sourceId: "benchlm", rawId: "google/gemini-2-5-pro", publisher: "google" }).id, "google/gemini-2.5-pro");
  assert.equal(canonicalModelId({ sourceId: "benchlm", rawId: "gemini-2-5-pro", publisher: "Google" }).id, "google/gemini-2.5-pro");
  assert.equal(canonicalModelId({ sourceId: "openrouter", rawId: "google/gemini-2.5-pro", publisher: "google" }).id, "google/gemini-2.5-pro");
  assert.deepEqual(splitRoutingVariant("openai/gpt-4o:batch"), { baseId: "openai/gpt-4o", variant: "batch" });
  assert.equal(canonicalModelId({ sourceId: "openrouter", rawId: "openai/gpt-4o:batch", publisher: "openai" }).id, "openai/gpt-4o");
  assert.equal(canonicalModelId({ sourceId: "portkey", rawId: "openai/gpt-4o:extended", publisher: "openai" }).variant, "extended");
  assert.equal(canonicalModelId({ sourceId: "benchlm", rawId: "z-ai/glm-4-5", publisher: "z-ai" }).id, "z-ai/glm-4.5");
  assert.equal(canonicalModelId({ sourceId: "benchlm", rawId: "meta/muse-spark-1-1", publisher: "meta" }).id, "meta/muse-spark-1.1");
  assert.equal(canonicalModelId({ sourceId: "models_dev", rawId: "openai/gpt-4o-20240806", publisher: "openai" }).id, "openai/gpt-4o-2024-08-06");

  const geminiDot = sourceRecord("openrouter", "google/gemini-2.5-pro", "Gemini 2.5 Pro", "gemini-dot");
  const geminiHyphen = sourceRecord("benchlm", "google/gemini-2-5-pro", "Gemini 2.5 Pro", "gemini-hyphen");
  geminiHyphen.offers = [];
  const geminiBatch = sourceRecord("openrouter", "google/gemini-2.5-pro:batch", "Gemini 2.5 Pro batch", "gemini-batch");
  geminiBatch.offers![0].variant = "batch";
  const geminiFlash = sourceRecord("openrouter", "google/gemini-2.5-flash", "Gemini 2.5 Flash", "gemini-flash");
  const gpt = sourceRecord("openrouter", "openai/gpt-4o", "GPT-4o", "gpt");
  const gptBatch = sourceRecord("openrouter", "openai/gpt-4o:batch", "GPT-4o batch", "gpt-batch");
  const gptDated = sourceRecord("models_dev", "openai/gpt-4o-2024-08-06", "GPT-4o (2024-08-06)", "gpt-dated");
  const glmDot = sourceRecord("openrouter", "z-ai/glm-4.5", "GLM 4.5", "glm-dot");
  const glmHyphen = sourceRecord("benchlm", "z-ai/glm-4-5", "GLM 4.5", "glm-hyphen");
  glmHyphen.offers = [];
  const museDot = sourceRecord("models_dev", "meta/muse-spark-1.1", "Muse Spark 1.1", "muse-dot");
  const museHyphen = sourceRecord("benchlm", "meta/muse-spark-1-1", "Muse Spark 1.1", "muse-hyphen");
  museHyphen.offers = [];
  const museLater = sourceRecord("models_dev", "meta/muse-spark-1.2", "Muse Spark 1.2", "muse-later");

  const snapshot = mergeSnapshots(undefined, [
    result("openrouter", [geminiDot, geminiBatch, geminiFlash, gpt, gptBatch, glmDot]),
    result("benchlm", [geminiHyphen, glmHyphen, museHyphen]),
    result("models_dev", [gptDated, museDot, museLater]),
  ], "2026-08-26T00:00:00.000Z");

  const ids = snapshot.models.map((model) => model.id).sort();
  assert.ok(ids.includes("google/gemini-2.5-pro"));
  assert.equal(ids.includes("google/gemini-2-5-pro"), false);
  assert.equal(ids.includes("google/gemini-2.5-pro:batch"), false);
  assert.ok(snapshot.models.find((model) => model.id === "google/gemini-2.5-pro")?.offers.some((offer) => offer.variant === "batch"));
  assert.ok(ids.includes("google/gemini-2.5-flash"));
  assert.ok(ids.includes("openai/gpt-4o"));
  assert.ok(ids.includes("openai/gpt-4o-2024-08-06"));
  assert.equal(ids.includes("openai/gpt-4o:batch"), false);
  assert.ok(ids.includes("z-ai/glm-4.5"));
  assert.equal(ids.includes("z-ai/glm-4-5"), false);
  assert.ok(ids.includes("meta/muse-spark-1.1"));
  assert.ok(ids.includes("meta/muse-spark-1.2"));
  assert.equal(ids.includes("meta/muse-spark-1-1"), false);
  assert.notEqual(canonicalModelId({ sourceId: "openrouter", rawId: "z-ai/glm-4.5" }).id, canonicalModelId({ sourceId: "openrouter", rawId: "zai-org/glm-4.5" }).id);
  assert.equal(canonicalModelId({ sourceId: "models_dev", rawId: "databricks/databricks-gemini-2-5-pro" }).id, "databricks/databricks-gemini-2-5-pro");
  assert.equal(canonicalModelId({ sourceId: "models_dev", rawId: "vendor/model-1-2" }).id, "vendor/model-1-2");
});

test("source replacement migrates a stale split identity into its canonical model", () => {
  const stale = sourceRecord("benchlm", "google/gemini-2-5-pro", "Gemini 2.5 Pro", "stale");
  stale.id = "google/gemini-2-5-pro";
  stale.aliases = [{ id: stale.id, source_id: "benchlm" }];
  stale.offers = [];
  const previous = mergeSnapshots(undefined, [result("benchlm", [stale])], "2026-08-25T00:00:00.000Z");

  const current = sourceRecord("benchlm", "google/gemini-2-5-pro", "Gemini 2.5 Pro", "current");
  current.offers = [];
  const refreshed = mergeSnapshots(previous, [{ ...result("benchlm", [current]), replace_previous: true }], "2026-08-26T00:00:00.000Z");

  assert.equal(refreshed.models.some((model) => model.id === "google/gemini-2-5-pro"), false);
  assert.equal(refreshed.models.filter((model) => model.id === "google/gemini-2.5-pro").length, 1);
});

test("benchmark observations expose a stable lane_id and reject mixed-lane score sorts", () => {
  const current = sourceRecord("vals", "openai/gpt-4o", "GPT-4o", "offer");
  current.release_date = "2026-01-01";
  current.benchmarks = [
    observation(current, { benchmark_id: "coding.terminalBench21", value: 40, metric: "score", unit: "percent", effort: "low", evaluator: "vals", dataset_version: "2.1" }),
    observation(current, { benchmark_id: "coding.terminalBench21", value: 70, metric: "score", unit: "percent", effort: "high", evaluator: "vals", dataset_version: "2.1" }),
    observation(current, { benchmark_id: "knowledge.mmluPro", value: 80, metric: "score", unit: "percent", effort: "high" }),
  ];
  const historical = sourceRecord("vals", "openai/gpt-3", "GPT-3", "old-offer");
  historical.release_date = "2020-06-01";
  historical.benchmarks = [
    observation(historical, { benchmark_id: "coding.terminalBench21", value: 10, metric: "score", unit: "percent", effort: "high", evaluator: "vals", dataset_version: "2.1" }),
  ];
  const snapshot = mergeSnapshots(undefined, [result("vals", [current, historical])], "2026-08-26T00:00:00.000Z");
  const listed = listBenchmarkObservations(snapshot, new URLSearchParams("benchmark=coding.terminalBench21&effort=high"));
  assert.equal(listed.meta.scope, "available");
  assert.equal(listed.data.length, 2);
  assert.ok(listed.data[0].lane_id);
  assert.equal(listed.data[0].lane_id, comparisonLaneId(listed.data[0]));
  assert.equal(listed.data[0].evidence.source_id, "vals");
  assert.equal(listed.meta.excluded_count, 0);

  const isolated = listBenchmarkObservations(snapshot, new URLSearchParams("benchmark=coding.terminalBench21&effort=high&metric=score&unit=percent&evaluator=vals&dataset_version=2.1&sort=score&direction=higher"));
  assert.equal(isolated.data.length, 2);
  assert.equal(isolated.data[0].value, 70);

  const sorted = listBenchmarkObservations(snapshot, new URLSearchParams(`lane_id=${listed.data[0].lane_id}&sort=score&direction=higher`));
  assert.equal(sorted.data.length, 2);
  assert.equal(sorted.data[0].lane_id, listed.data[0].lane_id);
  assert.equal(sorted.data[0].evidence.source_id, "vals");

  const all = listBenchmarkObservations(snapshot, new URLSearchParams("scope=all&benchmark=coding.terminalBench21&effort=high&sort=score&direction=higher"));
  assert.equal(all.meta.scope, "all");
  assert.equal(all.meta.excluded_count, 0);
  assert.deepEqual(all.data.map((row) => row.value), [70, 10]);

  assert.throws(() => listBenchmarkObservations(snapshot, new URLSearchParams("sort=score")), (error: unknown) => {
    return error instanceof QueryInputError && error.parameter === "sort";
  });
});

test("workload cost is complete for cache write, tiers, and reasoning or reports missing dimensions", () => {
  const complete = offerWithPricing(normalizeMillionPricing({ input: 1, output: 2, cache_read: 0.2, cache_write: 1.25, reasoning: 3, request: 0.001 }));
  complete.pricing.find((price) => price.dimension === "cache_write")!.cache_write_billing = "full_rate";
  const completeCost = estimateWorkloadCost(complete, {
    id: "custom",
    description: "test",
    input_tokens: 10_000,
    cached_input_ratio: 0.5,
    output_tokens: 300,
    requests_per_task: 2,
    cache_write_tokens: 4_000,
    reasoning_tokens: 100,
  });
  assert.equal(completeCost.missing_dimensions.length, 0);
  assert.ok(completeCost.estimated_cost_usd !== null);
  assert.ok((completeCost.components.cache_write ?? 0) > 0);
  assert.ok((completeCost.components.reasoning ?? 0) > 0);
  assert.ok((completeCost.components.request ?? 0) > 0);

  const missingCache = offerWithPricing(normalizeMillionPricing({ input: 1, output: 2 }));
  const missing = estimateWorkloadCost(missingCache, {
    id: "custom",
    description: "test",
    input_tokens: 10_000,
    cached_input_ratio: 0.5,
    output_tokens: 300,
    requests_per_task: 1,
  });
  assert.equal(missing.estimated_cost_usd, null);
  assert.ok(missing.missing_dimensions.includes("cache_read"));
  assert.ok(missing.missing_dimensions.includes("cache_write_tokens"));

  const snapshot = mergeSnapshots(undefined, [result("models_dev", [sourceRecord("models_dev", "openai/gpt-4o", "GPT-4o", "offer")])], "2026-08-26T00:00:00.000Z");
  snapshot.models[0].offers[0].pricing = normalizeMillionPricing({ input: 1, output: 2, cache_read: 0.2, cache_write: 1.25 });
  snapshot.models[0].offers[0].pricing.find((price) => price.dimension === "cache_write")!.cache_write_billing = "full_rate";
  const listed = listOffers(snapshot, new URLSearchParams("profile=custom&input_tokens=10000&output_tokens=300&cached_input_ratio=0.5&cache_write_tokens=4000"));
  assert.equal(listed.data[0].missing_dimensions?.length, 0);
  assert.ok((listed.data[0].estimated_cost_usd ?? 0) > 0);

  const tiered = offerWithPricing([
    { dimension: "input", unit: "million_tokens", amount_usd_per_unit: 1, raw: 1, kind: "tiered", tier: { type: "context", min: 0, max: 200_000 } },
    { dimension: "input", unit: "million_tokens", amount_usd_per_unit: 2, raw: 2, kind: "tiered", tier: { type: "context", min: 200_000 } },
    { dimension: "output", unit: "million_tokens", amount_usd_per_unit: 3, raw: 3, kind: "fixed" },
  ]);
  const low = estimateWorkloadCost(tiered, { id: "custom", description: "t", input_tokens: 1_000, cached_input_ratio: 0, output_tokens: 10, requests_per_task: 1 });
  const high = estimateWorkloadCost(tiered, { id: "custom", description: "t", input_tokens: 250_000, cached_input_ratio: 0, output_tokens: 10, requests_per_task: 1 });
  assert.equal(low.missing_dimensions.length, 0);
  assert.equal(high.missing_dimensions.length, 0);
  assert.ok((high.estimated_cost_usd ?? 0) > (low.estimated_cost_usd ?? 0));

  const fixedWithLongContextOverride = offerWithPricing([
    { dimension: "input", unit: "million_tokens", amount_usd_per_unit: 1, raw: 1, kind: "fixed" },
    { dimension: "input", unit: "million_tokens", amount_usd_per_unit: 2, raw: 2, kind: "tiered", tier: { type: "context", min: 200_000 } },
    { dimension: "output", unit: "million_tokens", amount_usd_per_unit: 3, raw: 3, kind: "fixed" },
  ]);
  const longContext = estimateWorkloadCost(fixedWithLongContextOverride, { id: "custom", description: "t", input_tokens: 250_000, cached_input_ratio: 0, output_tokens: 10, requests_per_task: 1 });
  assert.equal(longContext.missing_dimensions.length, 0);
  assert.ok((longContext.components.input ?? 0) > 0.49);

  const unresolvedRequest = offerWithPricing([
    ...normalizeMillionPricing({ input: 1, output: 2 }),
    { dimension: "request", unit: "request", amount_usd_per_unit: null, raw: -1, kind: "variable" },
  ]);
  const unresolved = estimateWorkloadCost(unresolvedRequest, { id: "custom", description: "t", input_tokens: 1_000, cached_input_ratio: 0, output_tokens: 10, requests_per_task: 1 });
  assert.equal(unresolved.estimated_cost_usd, null);
  assert.ok(unresolved.missing_dimensions.includes("request"));
});

test("runtime query artifact retains observations and the API cache lasts for the instance lifetime", async () => {
  const snapshot = fixtureSnapshot();
  const artifact = buildRuntimeQueryArtifact(snapshot);
  assert.equal(artifact.content_hash, snapshot.content_hash);
  assert.equal("benchmarks" in artifact.models[0], false);
  assert.ok(Array.isArray(artifact.observations));
  assert.equal(artifact.models.length, snapshot.models.length);

  const directory = await mkdtemp(join(tmpdir(), "runtime-query-"));
  const artifactPath = join(directory, "runtime-query.json");
  const archivePath = join(directory, "models_db.json");
  try {
    await writeFile(artifactPath, `${JSON.stringify(artifact)}\n`);
    await writeFile(archivePath, `${JSON.stringify(snapshot)}\n`);
    let clock = 0;
    const first = loadSnapshot({ path: artifactPath, now: () => clock });
    assert.equal(first.content_hash, snapshot.content_hash);
    const mutated = structuredClone(snapshot);
    mutated.models[0].name = "changed";
    await writeFile(artifactPath, `${JSON.stringify(mutated)}\n`);
    clock = 60 * 60 * 1000 + 1;
    assert.equal(loadSnapshot({ path: artifactPath, now: () => clock }).models[0].name, first.models[0].name);
    assert.equal(loadSnapshot({ path: artifactPath, now: () => clock }), first);
  } finally {
    clearSnapshotCache();
    await rm(directory, { recursive: true, force: true });
  }
});

test("static builds load the archival snapshot even when a stale runtime artifact exists", async () => {
  const directory = await mkdtemp(join(tmpdir(), "archive-source-"));
  const archive = fixtureSnapshot();
  const stale = structuredClone(archive);
  stale.content_hash = "stale";
  stale.models[0].name = "stale runtime";
  try {
    await writeFile(join(directory, "models_db.json"), `${JSON.stringify(archive)}\n`);
    await writeFile(join(directory, "runtime-query.json"), `${JSON.stringify(stale)}\n`);
    clearSnapshotCache();
    assert.equal(loadArchiveSnapshot(directory).content_hash, archive.content_hash);
    assert.equal(loadArchiveSnapshot(directory).models[0].name, archive.models[0].name);
  } finally {
    clearSnapshotCache();
    await rm(directory, { recursive: true, force: true });
  }
});

function fixtureSnapshot() {
  const record = sourceRecord("models_dev", "openai/gpt-4o", "GPT-4o", "offer");
  record.release_date = "2026-01-01";
  record.offers![0].pricing = normalizeMillionPricing({ input: 1, output: 2, cache_read: 0.2 });
  return mergeSnapshots(undefined, [result("models_dev", [record])], "2026-08-26T00:00:00.000Z");
}

function observation(record: SourceRecord, fields: Partial<BenchmarkObservation> & Pick<BenchmarkObservation, "benchmark_id" | "value">): BenchmarkObservation {
  return {
    metric: "score",
    unit: "percent",
    evidence: record.evidence![0],
    ...fields,
  };
}

function offerWithPricing(pricing: Offer["pricing"]): Offer {
  return {
    id: "offer",
    provider_id: "openai",
    provider_model_id: "openai/gpt-4o",
    status: "active",
    supported_parameters: [],
    capabilities: {},
    reasoning_efforts: [],
    pricing,
    runtime: [],
    measurements: [],
    evidence: [{ source_id: "models_dev", url: "https://models.dev", fetched_at: "2026-08-26T00:00:00.000Z", status: "observed" }],
  };
}

function result(sourceId: string, records: SourceRecord[]): SourceResult {
  return { source_id: sourceId, url: `https://${sourceId}.example`, fetched_at: "2026-08-26T00:00:00.000Z", status: "ok", records };
}

function sourceRecord(sourceId: string, rawId: string, name: string, offerId: string): SourceRecord {
  const identity = canonicalModelId({ sourceId, rawId, publisher: rawId.split("/")[0], name });
  return {
    id: identity.id,
    identity_confidence: identity.confidence,
    name,
    release_date: "2026-01-01",
    creators: [rawId.split("/")[0]],
    aliases: [{ id: rawId, source_id: sourceId }],
    open_weights: null,
    modalities: { input: ["text"], output: ["text"] },
    capabilities: { tools: true, structured_outputs: true },
    reasoning: [],
    offers: [{
      id: offerId,
      provider_id: "openai",
      provider_name: "OpenAI",
      provider_model_id: rawId,
      ...(identity.variant ? { variant: identity.variant } : {}),
      status: "active",
      supported_parameters: ["tools"],
      capabilities: { tools: true },
      reasoning_efforts: [],
      pricing: [],
      runtime: [],
      measurements: [],
      evidence: [{ source_id: sourceId, url: `https://${sourceId}.example`, fetched_at: "2026-08-26T00:00:00.000Z", status: "observed" }],
    }],
    benchmarks: [],
    pricing_observations: [],
    runtime_observations: [],
    measurements: [],
    evidence: [{ source_id: sourceId, url: `https://${sourceId}.example`, fetched_at: "2026-08-26T00:00:00.000Z", status: "observed" }],
  };
}
