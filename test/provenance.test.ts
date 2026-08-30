import assert from "node:assert/strict";
import test from "node:test";
import { mergeSnapshots } from "../src/merge.js";
import { offer } from "../src/sources/common.js";
import type { Evidence, SourceRecord, SourceResult } from "../src/types.js";
import { offerInAvailableScope } from "../src/scope.js";

const now = "2026-08-31T00:00:00.000Z";
const proof = (sourceId: string): Evidence => ({ source_id: sourceId, url: `https://${sourceId}.example`, fetched_at: now, status: "observed" });
function source(sourceId: string, metadata: Partial<SourceRecord> = {}, replace = false): SourceResult {
  return {
    source_id: sourceId, url: proof(sourceId).url, fetched_at: now, status: "ok", replace_previous: replace,
    records: [{ id: "creator/model", evidence: [proof(sourceId)], ...metadata }],
  };
}

test("complete source replacement removes withdrawn metadata without erasing retained sources", () => {
  const previous = mergeSnapshots(undefined, [
    source("a", { name: "Model A", creators: ["creator-a"], context_tokens: 200_000,
      modalities: { input: ["text", "image"], output: ["text"] }, capabilities: { tools: true }, open_weights: true }),
    source("b", { name: "Model B", creators: ["creator-b"], license: "MIT" }),
  ], now);
  const refreshed = mergeSnapshots(previous, [source("a", {
    modalities: { input: ["text"], output: ["text"] }, capabilities: { tools: false }, open_weights: false,
  }, true)], now).models[0];
  assert.equal(refreshed.context_tokens, undefined);
  assert.equal(refreshed.open_weights, false);
  assert.equal(refreshed.capabilities.tools, false);
  assert.deepEqual(refreshed.modalities.input, ["text"]);
  assert.deepEqual(refreshed.creators, ["creator-b"]);
  assert.equal(refreshed.license, "MIT");
  assert.equal(refreshed.name, "Model B");
  assert.deepEqual(Object.keys(refreshed.metadata_by_source ?? {}), ["a", "b"]);
});

test("source replacement recomputes a shared offer instead of retaining obsolete rates and capabilities", () => {
  function route(sourceId: string, price?: number) {
    return offer({ id: `${sourceId}:route`, providerId: "provider", providerModelId: "native/model",
      capabilities: price === 1 ? { tools: true } : {}, evidence: [proof(sourceId)],
      ...(price === 1 ? { contextTokens: 200_000 } : {}),
      pricing: price === undefined ? [] : [{ dimension: "input", unit: "million_tokens", amount_usd_per_unit: price, raw: price, kind: "fixed" }],
    });
  }
  const previous = mergeSnapshots(undefined, [source("a", { offers: [route("a", 1)] }), source("b", { offers: [route("b")] })], now);
  assert.deepEqual(Object.keys(previous.models[0].offers[0].source_projections ?? {}), ["a", "b"]);
  const refreshed = mergeSnapshots(previous, [source("a", { offers: [route("a", 3)] }, true)], now).models[0].offers[0];
  assert.deepEqual(refreshed.pricing.map((price) => price.amount_usd_per_unit), [3]);
  assert.equal(refreshed.capabilities.tools, undefined);
  assert.equal(refreshed.context_tokens, undefined);
  assert.deepEqual(refreshed.evidence.map((value) => value.source_id), ["a", "b"]);
});

test("unknown open-weight metadata does not overwrite a declaration and conflicting declarations remain unknown", () => {
  for (const declared of [true, false]) {
    const snapshot = mergeSnapshots(undefined, [source("a", { open_weights: declared }), source("b", { open_weights: null })], now);
    assert.equal(snapshot.models[0].open_weights, declared);
  }
  assert.equal(mergeSnapshots(undefined, [source("a", { open_weights: true }), source("b", { open_weights: false }),
    source("c", { open_weights: null })], now).models[0].open_weights, null);
});

test("incremental observations replace one protocol without deleting other dataset versions or evaluators", () => {
  const observation = (value: number, datasetVersion: string, evaluator = "harness-a") => ({
    benchmark_id: "source.custom", value, metric: "accuracy", unit: "percent", dataset_version: datasetVersion,
    evaluator, evidence: proof("a"),
  });
  const original = mergeSnapshots(undefined, [source("a", { benchmarks: [observation(10, "v1"), observation(20, "v2"), observation(30, "v2", "harness-b")] })], now);
  const refreshed = mergeSnapshots(original, [source("a", { benchmarks: [observation(25, "v2")] })], now);
  assert.deepEqual(refreshed.models[0].benchmarks.map((value) => value.value).sort((a, b) => a - b), [10, 25, 30]);
});

test("legacy mixed metadata is not reattributed to a surviving source on replacement", () => {
  const legacy = mergeSnapshots(undefined, [source("a", { context_tokens: 1_000_000, capabilities: { vision: true } }), source("b")], now);
  delete legacy.models[0].metadata_by_source;
  const refreshed = mergeSnapshots(legacy, [source("a", {}, true)], now).models[0];
  assert.equal(refreshed.context_tokens, undefined);
  assert.equal(refreshed.capabilities.vision, undefined);
});

test("a benchmark alias never gives another source ownership of its authoritative definition", () => {
  const authoritative = { ...source("benchlm"), benchmark_definitions: [{ id: "coding.sweVerified", aliases: ["vals.swebench"], name: "Authoritative description", evidence: proof("benchlm") }] };
  const previous = mergeSnapshots(undefined, [authoritative, source("vals")], now);
  const failed = { ...authoritative, status: "error" as const, records: [], benchmark_definitions: [], error: "unavailable" };
  const refreshed = mergeSnapshots(previous, [failed, source("vals", {}, true)], now);
  assert.equal(refreshed.benchmarks.find((definition) => definition.id === "coding.sweVerified")?.name, "Authoritative description");
});

test("fresh pricing cannot reactivate a deprecated route or freshen old availability evidence", () => {
  for (const status of ["absent", "active"] as const) {
    const oldEvidence = { ...proof("models_dev"), fetched_at: "2026-08-01T00:00:00Z", fields: ["provider_model", "pricing"] };
    const catalog = offer({ id: "catalog", providerId: "provider", providerModelId: "model", status, evidence: [oldEvidence] });
    const pricing = offer({ id: "pricing", providerId: "provider", providerModelId: "model", evidence: [{ ...proof("portkey"), fields: ["pricing"] }] });
    const merged = mergeSnapshots(undefined, [source("models_dev", { offers: [catalog] }), source("portkey", { offers: [pricing] })], now);
    const route = merged.models[0].offers[0];
    assert.equal(route.status, status);
    assert.equal(offerInAvailableScope(route, now), false);
  }
});
