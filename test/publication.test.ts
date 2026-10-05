import assert from "node:assert/strict";
import test from "node:test";
import { mergeSnapshots } from "../src/merge.js";
import { assertPublicationAllowed, redactRestrictedPublication } from "../src/publication.js";
import { offer } from "../src/sources/common.js";
import type { Evidence, SourceResult } from "../src/types.js";

const now = "2026-08-31T00:00:00.000Z";

test("automatic publication requires license confirmation for retained or derived restricted evidence", () => {
  for (const sourceId of ["artificial_analysis", "artificial_analysis_stt", "benchlm"]) for (const status of ["observed", "stale"] as const) {
    const snapshot = mergeSnapshots(undefined, [{ source_id: sourceId, url: "https://fixture.example", fetched_at: now, status: "ok",
      records: [{ id: "vendor/model", evidence: [{ source_id: sourceId, url: "https://fixture.example", fetched_at: now, status,
        ...(sourceId === "benchlm" ? { derived_from: ["artificial-analysis"] } : {}) }] }] }], now);
    for (const confirmation of [undefined, "0", "true", "yes"]) assert.throws(() => assertPublicationAllowed(snapshot, confirmation), /publication blocked/);
    assert.equal(assertPublicationAllowed(snapshot, "1").evidence_count, 1);
    snapshot.sources[0].status = "skipped";
    assert.throws(() => assertPublicationAllowed(snapshot), /publication blocked/);
  }
});

test("a source status without retained restricted observations does not block publication", () => {
  const snapshot = mergeSnapshots(undefined, [{ source_id: "artificial_analysis", url: "https://fixture.example", fetched_at: now, status: "skipped", records: [] }], now);
  assert.equal(assertPublicationAllowed(snapshot).evidence_count, 0);
});

const proof = (sourceId: string, extra: Partial<Evidence> = {}): Evidence => ({
  source_id: sourceId, url: `https://${sourceId}.example/${extra.derived_from?.join("-") ?? "row"}`, fetched_at: now, status: "observed", ...extra,
});

function collected(sourceId: string, records: SourceResult["records"], definitions?: SourceResult["benchmark_definitions"]): SourceResult {
  return { source_id: sourceId, url: `https://${sourceId}.example/catalog`, fetched_at: now, status: "ok", records, benchmark_definitions: definitions };
}

test("redaction publishes the other scores and deletes Artificial Analysis rows instead of zeroing them", () => {
  const snapshot = mergeSnapshots(undefined, [
    collected("benchlm", [{ id: "vendor/mixed", name: "Public", evidence: [proof("benchlm")], benchmarks: [
      { benchmark_id: "coding.deepSwe", value: 74.1, evidence: proof("benchlm") },
    ] }], [{ id: "coding.deepSwe", name: "DeepSWE", evidence: proof("benchlm") }]),
    collected("artificial_analysis", [
      { id: "vendor/mixed", name: "AA secret", evidence: [proof("artificial_analysis")], benchmarks: [
        { benchmark_id: "agentic.aaTerminalBench4", value: 59.1, evidence: proof("artificial_analysis") },
      ] },
      { id: "vendor/aa-only", name: "AA only", evidence: [proof("artificial_analysis")], benchmarks: [
        { benchmark_id: "agentic.aaTerminalBench4", value: 42, evidence: proof("artificial_analysis") },
      ] },
    ], [{ id: "agentic.aaTerminalBench4", name: "AA Terminal-Bench", evidence: proof("artificial_analysis") }]),
  ], now);
  const redacted = redactRestrictedPublication(snapshot);
  assert.deepEqual(redacted.models.map((model) => model.id), ["vendor/mixed"]);
  assert.equal(redacted.models[0].name, "Public");
  assert.deepEqual(redacted.models[0].benchmarks.map((row) => row.value), [74.1]);
  assert.deepEqual(redacted.benchmarks.map((row) => row.id), ["coding.deepSwe"]);
  assert.equal(JSON.stringify(redacted).includes("AA secret"), false);
  assert.equal(JSON.stringify(redacted).includes("AA only"), false);
  assert.equal(redacted.sources.some((source) => source.source_id === "artificial_analysis"), true);
  assert.equal(assertPublicationAllowed(redacted).evidence_count, 0);
  assert.throws(() => assertPublicationAllowed(snapshot), /publication blocked/);
});

test("redaction removes observations derived from Artificial Analysis and leaves the sibling score", () => {
  const clean = proof("benchlm");
  const derived = proof("benchlm", { derived_from: ["artificial-analysis"] });
  const snapshot = mergeSnapshots(undefined, [collected("benchlm", [{ id: "vendor/model", evidence: [clean, derived], benchmarks: [
    { benchmark_id: "coding.deepSwe", value: 70, evidence: clean },
    { benchmark_id: "agentic.aaTerminalBench4", value: 55, evidence: derived },
  ] }])], now);
  const redacted = redactRestrictedPublication(snapshot);
  assert.deepEqual(redacted.models[0].benchmarks.map((row) => row.value), [70]);
  assert.equal(JSON.stringify(redacted).includes("artificial-analysis"), false);
  assert.equal(assertPublicationAllowed(redacted).evidence_count, 0);
});

test("redaction removes an Artificial Analysis evaluator score even without derived_from", () => {
  const evidence = proof("benchgecko");
  const snapshot = mergeSnapshots(undefined, [collected("benchgecko", [{ id: "vendor/model", evidence: [evidence], benchmarks: [
    { benchmark_id: "coding.deepSwe", value: 11, evidence },
    { benchmark_id: "agentic.aaAgenticIndex", evaluator: "artificial_analysis", value: 42, evidence },
  ] }])], now);
  const redacted = redactRestrictedPublication(snapshot);
  assert.deepEqual(redacted.models[0].benchmarks.map((row) => row.value), [11]);
  assert.equal(JSON.stringify(redacted.models).includes("42"), false);
  assert.equal(assertPublicationAllowed(redacted).evidence_count, 0);
});

test("redaction keeps the non-AA price projection and drops restricted runtime on an unsplit offer", () => {
  const route = (sourceId: string, price: number) => offer({
    id: `${sourceId}:route`, providerId: "provider", providerModelId: "native/model", evidence: [proof(sourceId)],
    pricing: [{ dimension: "input", unit: "million_tokens", amount_usd_per_unit: price, raw: price, kind: "fixed" }],
  });
  const merged = mergeSnapshots(undefined, [
    collected("benchlm", [{ id: "vendor/model", evidence: [proof("benchlm")], offers: [route("benchlm", 3)] }]),
    collected("artificial_analysis", [{ id: "vendor/model", evidence: [proof("artificial_analysis")], offers: [route("artificial_analysis", 9)] }]),
  ], now);
  assert.deepEqual(Object.keys(merged.models[0].offers[0].source_projections ?? {}).sort(), ["artificial_analysis", "benchlm"]);
  const redacted = redactRestrictedPublication(merged).models[0].offers[0];
  assert.equal(redacted.source_projections, undefined);
  assert.deepEqual(redacted.pricing.map((price) => price.amount_usd_per_unit), [3]);

  const evidence = proof("benchlm");
  const withRuntime = mergeSnapshots(undefined, [collected("benchlm", [{ id: "vendor/runtime", evidence: [evidence], offers: [offer({
    id: "route", providerId: "provider", providerModelId: "native/model", evidence: [evidence],
    pricing: [{ dimension: "input", unit: "million_tokens", amount_usd_per_unit: 3, raw: 3, kind: "fixed" }],
    runtime: [{ scope: "offer", throughput_tokens_per_second: { p50: 10 }, evidence: proof("artificial_analysis") }],
  })] }])], now);
  const kept = redactRestrictedPublication(withRuntime);
  assert.equal(kept.models[0].offers[0].runtime.length, 0);
  assert.deepEqual(kept.models[0].offers[0].pricing.map((price) => price.amount_usd_per_unit), [3]);
  assert.equal(assertPublicationAllowed(kept).evidence_count, 0);
});

test("a republished AA evaluator requires review even without a derived_from marker", () => {
  for (const evidenceSource of ["benchgecko", "artificial_analysis"]) {
    const evidence = { source_id: evidenceSource, url: "https://fixture.example", fetched_at: now, status: "observed" as const };
    const snapshot = mergeSnapshots(undefined, [{ source_id: "benchgecko", url: evidence.url, fetched_at: now, status: "ok", records: [
      { id: "vendor/model", benchmarks: [{ benchmark_id: "agentic.aaAgenticIndex", evaluator: "artificial_analysis", value: 42, evidence }] },
    ] }], now);
    assert.throws(() => assertPublicationAllowed(snapshot), /publication blocked/);
    assert.equal(assertPublicationAllowed(snapshot, "1").evidence_count, 1);
  }
});
