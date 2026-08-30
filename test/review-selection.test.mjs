import assert from "node:assert/strict";
import test from "node:test";
import { comparisonLane, parseSelectionArgs, scoreCandidates, selectCandidates } from "../.agents/skills/model-that-fits-my-task/scripts/select-models.mjs";
import { qualityCostPareto } from "../.agents/skills/model-that-fits-my-task/scripts/quality-cost-pareto.mjs";
import { validateDecision } from "../.agents/skills/model-that-fits-my-task/scripts/validate-decision.mjs";

const now = "2026-08-31T00:00:00.000Z";
const evidence = { source_id: "fixture", url: "https://fixture.example", fetched_at: now, status: "observed" };
function route(id, amount = 1) {
  return { id, provider_id: "provider", provider_model_id: id, status: "active", context_tokens: 10000, max_output_tokens: 1000,
    reasoning_efforts: [], capabilities: {}, supported_parameters: [], evidence: [evidence],
    pricing: ["input", "output"].map((dimension) => ({ dimension, unit: "million_tokens", amount_usd_per_unit: amount, raw: amount, kind: "fixed" })) };
}
const profile = { input_tokens: 1000, output_tokens: 100, requests_per_task: 1, cached_input_ratio: 0 };
const paretoOptions = { pareto: "quality-cost", profile: null, workload: profile, minTaskFit: 0, efforts: [], speedScope: "offer" };
function candidate(id, offers) {
  return { canonical_model_id: id, name: id, matching_offers: offers,
    task_fit: { aggregate_score: 80, confidence: 1, coverage: 1, contributions: [{ status: "scored", effort: null, configuration: {} }] } };
}

test("explicit model IDs and transitive aliases cannot substitute a different or unknown release", () => {
  const record = (id, release, aliases, offers) => ({ id, name: id, release_date: release, aliases: aliases.map((alias) => ({ id: alias, source_id: "fixture" })),
    identity_confidence: "exact", offers, benchmarks: [], evidence: [evidence] });
  const snapshot = { generated_at: now, models: [
    record("new", "2026-08-01", ["old", "bridge"], [route("new-a"), route("new-b")]),
    record("old", "2025-01-01", ["bridge"], [route("old")]),
    record("bridge", undefined, ["new", "old"], [route("bridge")]),
  ] };
  for (const id of ["new", "old", "bridge"]) {
    const result = selectCandidates(snapshot, parseSelectionArgs(["--cache", "/unused", "--model", id]));
    assert.equal(result.meta.total, 1);
    assert.equal(result.data[0].canonical_model_id, id);
    assert.deepEqual(result.data[0].record_ids, [id]);
  }
});

test("unverified workload limits do not dominate a proven compatible route", () => {
  const known = route("known", 2);
  const unknown = route("unknown", 1);
  delete unknown.context_tokens;
  delete unknown.max_output_tokens;
  const result = qualityCostPareto([candidate("model", [known, unknown])], {}, paretoOptions);
  assert.deepEqual(result.front.map((row) => row.offer_id), ["known"]);
  assert.equal(result.unranked[0].workload_compatibility.status, "unknown");
});

test("quality transfer checks effort and both directions of quantization uncertainty", () => {
  const offer = route("route");
  offer.reasoning_efforts = ["low", "high"];
  const model = candidate("model", [offer]);
  model.task_fit.contributions[0].effort = "high";
  const result = qualityCostPareto([model], {}, { ...paretoOptions, efforts: ["low", "high"] });
  assert.deepEqual(result.front.map((row) => row.reasoning_effort), ["high"]);
  assert.equal(result.unranked[0].quality_transfer.status, "incompatible");
  for (const evaluatedKnown of [true, false]) {
    const changed = candidate("model", [route("route")]);
    if (evaluatedKnown) changed.task_fit.contributions[0].configuration.quantization = "fp8";
    else changed.matching_offers[0].quantization = "fp8";
    const uncertain = qualityCostPareto([changed], {}, paretoOptions);
    assert.equal(uncertain.front.length, 0);
    assert.equal(uncertain.unranked[0].quality_transfer.status, "unknown");
  }
});

test("equivalent Pareto objective values preserve different model identities", () => {
  const result = qualityCostPareto([candidate("model-a", [route("a")]), candidate("model-b", [route("b")])], {}, paretoOptions);
  assert.deepEqual(result.front.map((row) => row.canonical_model_id), ["model-a", "model-b"]);
  assert.ok(result.front.every((row) => row.equivalent_offers[0].canonical_model_id === row.canonical_model_id));
});

test("claim and aggregate rows cannot enter scoring because of row ordering", () => {
  for (const kind of ["claim", "aggregate"]) for (const reverse of [true, false]) {
    const row = { benchmark_id: "fixture.benchmark", metric: "accuracy", evidence };
    const lane = comparisonLane(row).lane_id;
    const candidates = [
      { canonical_model_id: "measured", observations: [{ ...row, lane_id: lane, kind: "benchmark", value: 1 }] },
      { canonical_model_id: "claimed", observations: [{ ...row, lane_id: lane, kind, value: 100 }] },
    ];
    if (reverse) candidates.reverse();
    assert.throws(() => scoreCandidates(candidates, [{ target: lane, weight: 1 }]), /not independent ranking evidence/);
  }
});

test("null and string values remain missing evidence rather than a measured zero", () => {
  const row = { benchmark_id: "fixture.benchmark", metric: "accuracy", evidence };
  const lane = comparisonLane(row).lane_id;
  const candidates = [null, "", false, "10", 10].map((value, index) => ({ canonical_model_id: String(index), observations: [{ ...row, lane_id: lane, value }] }));
  scoreCandidates(candidates, [{ target: lane, weight: 1 }]);
  assert.deepEqual(candidates.map((row) => row.task_fit.aggregate_score), [null, null, null, null, 50]);
});

test("decision validation refuses null evidence, absent cost amounts and invalid score ranges", () => {
  const errors = validateDecision({ recommendations: [{ model_id: "model", quality_transfer: { status: "exact", lane_id: null, evidence: "fixture" },
    cost: { status: "estimated", assumptions: "fixture" }, sources: [null], task_fit: { aggregate_score: 150, observed_score: -1, coverage: 2, confidence: -1 } }] });
  for (const field of ["lane_id", "estimated_cost_usd", "sources", "aggregate_score", "coverage", "confidence"]) assert.ok(errors.some((error) => error.includes(field)), field);
});
