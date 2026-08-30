import assert from "node:assert/strict";
import test from "node:test";
import { comparisonLaneId } from "../src/lane.js";
import { mergeSnapshots } from "../src/merge.js";
import { getModel, listBenchmarkObservations, listFacets, listModels, listOffers, listProviders, QueryInputError } from "../src/query.js";
import { offer } from "../src/sources/common.js";
import type { BenchmarkObservation, SourceRecord } from "../src/types.js";
import { parseScoreDimension, scoreCandidates } from "../.agents/skills/model-that-fits-my-task/scripts/task-fit-score.mjs";
import { sendError, sendJson, type ApiResponse } from "../src/api.js";

const now = "2026-08-31T00:00:00.000Z";
const evidence = { source_id: "fixture", url: "https://fixture.example", fetched_at: now, status: "observed" as const };

function snapshot(records: SourceRecord[]) {
  return mergeSnapshots(undefined, [{ source_id: "fixture", url: evidence.url, fetched_at: now, status: "ok", records }], now);
}

test("source provenance separates otherwise unspecified comparison protocols", () => {
  const observation = { benchmark_id: "knowledge.hle", evidence };
  assert.notEqual(comparisonLaneId(observation), comparisonLaneId({ ...observation, evidence: { source_id: "other" } }));
  assert.equal(comparisonLaneId(observation), comparisonLaneId({ ...observation, evidence: { source_id: "fixture" } }));
});

test("API and offline scores rank WER lower and distinguish Brier index from Brier score", () => {
  for (const [metric, best] of [["wer", 8], ["brier_score", 8], ["brier_index", 86]] as const) {
    const rows: BenchmarkObservation[] = [8, 86].map((value) => ({ benchmark_id: "fixture.quality", metric, value, evidence }));
    const db = snapshot(rows.map((row, index) => ({ id: `vendor/${index}`, benchmarks: [row], evidence: [evidence] })));
    const ranked = listBenchmarkObservations(db, new URLSearchParams("scope=all&sort=score"));
    assert.equal(ranked.data[0].value, best);
    assert.equal(ranked.meta.score_direction, metric === "brier_index" ? "higher" : "lower");
    const candidates = rows.map((row, index) => ({ canonical_model_id: `vendor/${index}`, observations: [{ ...row, lane_id: comparisonLaneId(row) }] }));
    scoreCandidates(candidates, [parseScoreDimension("fixture.quality")]);
    assert.equal((candidates as any[]).find((row) => row.observations[0].value === best).task_fit.aggregate_score, 100);
  }
});

test("unknown or conflicting score direction cannot silently rank a lane", () => {
  const row = { benchmark_id: "fixture.quality", metric: "score", value: 1, evidence };
  const db = snapshot([{ id: "vendor/a", benchmarks: [row], evidence: [evidence] }]);
  assert.throws(() => listBenchmarkObservations(db, new URLSearchParams("scope=all&sort=score")), (error: unknown) => error instanceof QueryInputError && error.parameter === "direction");
  assert.equal(listBenchmarkObservations(db, new URLSearchParams("scope=all&sort=score&direction=higher")).data.length, 1);
  const candidates = [{ canonical_model_id: "vendor/a", observations: [{ ...row, lane_id: comparisonLaneId(row) }] }];
  assert.throws(() => scoreCandidates(candidates, [parseScoreDimension("fixture.quality")]), /direction is unknown/);
  const wer = snapshot([{ id: "vendor/a", benchmarks: [{ ...row, metric: "wer" }], evidence: [evidence] }]);
  assert.throws(() => listBenchmarkObservations(wer, new URLSearchParams("scope=all&sort=score&direction=higher")), /conflicting/);
});

test("available summaries, facets, provider totals and context sorting use eligible offers", () => {
  const active = offer({ id: "active", providerId: "active", providerModelId: "a", contextTokens: 100, capabilities: { tools: false }, evidence: [evidence] });
  const absent = { ...offer({ id: "absent", providerId: "absent", providerModelId: "a", contextTokens: 1000, capabilities: { tools: true }, evidence: [evidence] }), status: "absent" as const };
  const larger = offer({ id: "larger", providerId: "active", providerModelId: "b", contextTokens: 200, capabilities: { tools: true }, evidence: [evidence] });
  const db = snapshot([
    { id: "vendor/a", identity_confidence: "exact", context_tokens: 1000, capabilities: { tools: true }, offers: [active, absent], evidence: [evidence] },
    { id: "vendor/b", identity_confidence: "exact", context_tokens: 10, offers: [larger], evidence: [evidence] },
    { id: "vendor/c", identity_confidence: "exact", offers: [{ ...absent, id: "other-absent", provider_id: "active", provider_model_id: "c" }], evidence: [evidence] },
  ]);
  const page = listModels(db, new URLSearchParams("view=summary&sort=context"));
  assert.deepEqual(page.data.map((row) => row.id), ["vendor/b", "vendor/a"]);
  const summary = page.data[1] as any;
  assert.equal(summary.context_tokens, 100);
  assert.equal(summary.offer_count, 1);
  assert.deepEqual(summary.providers, ["active"]);
  assert.deepEqual(summary.capabilities, []);
  assert.equal(listFacets(db).capabilities.find((row) => row.value === "tools")?.model_count, 1);
  const provider = listProviders(db).find((row) => row.provider_id === "active");
  assert.equal(provider?.offer_count, 2);
  assert.equal(provider?.model_count, 2);
  const excluded = listModels(db, new URLSearchParams("provider=absent"));
  assert.equal(excluded.meta.total, 0);
  assert.equal(excluded.meta.excluded_count, 1);
});

test("query counts reject blank, nondecimal and unsafe integers", () => {
  const db = snapshot([]);
  for (const query of ["limit=", "offset=0x10", "min_context=%20", "limit=1e100", "limit=9007199254740992", "min_context=0.5"]) {
    assert.throws(() => listModels(db, new URLSearchParams(query)), QueryInputError, query);
  }
  assert.throws(() => listOffers(db, new URLSearchParams("profile=custom&input_tokens=1e308&output_tokens=1")), QueryInputError);
  assert.throws(() => getModel(db, "%"), (error: unknown) => error instanceof QueryInputError && error.parameter === "id");
});

test("offer cost is keyed by the model route and budget excludes impossible or unverified workloads", () => {
  function route(id: string, amount: number, limits = true) {
    return offer({ id: "same-id", providerId: "provider", providerModelId: id,
      ...(limits ? { contextTokens: 2_000_000, maxOutputTokens: 10000 } : {}),
      pricing: [{ dimension: "input", unit: "million_tokens", amount_usd_per_unit: amount, raw: amount, kind: "fixed" }], evidence: [evidence] });
  }
  const db = snapshot([
    { id: "vendor/cheap", identity_confidence: "exact", offers: [route("cheap", 1)], evidence: [evidence] },
    { id: "vendor/expensive", identity_confidence: "exact", offers: [route("expensive", 10)], evidence: [evidence] },
    { id: "vendor/unknown", identity_confidence: "exact", offers: [route("unknown", 0, false)], evidence: [evidence] },
    { id: "vendor/impossible", identity_confidence: "exact", offers: [{ ...route("impossible", 0), context_tokens: 100 }], evidence: [evidence] },
  ]);
  const query = "profile=custom&input_tokens=1000000&output_tokens=0&sort=cost";
  const all = listOffers(db, new URLSearchParams(query));
  assert.deepEqual(all.data.map((row) => [row.model_id, row.estimated_cost_usd, row.workload_compatibility?.status]), [
    ["vendor/cheap", 1, "compatible"], ["vendor/expensive", 10, "compatible"],
    ["vendor/unknown", 0, "unknown"], ["vendor/impossible", 0, "incompatible"],
  ]);
  assert.deepEqual(listOffers(db, new URLSearchParams(`${query}&max_cost_usd=5`)).data.map((row) => row.model_id), ["vendor/cheap"]);
  db.models.find((row) => row.id === "vendor/expensive")!.offers[0].status = "absent";
  const refreshed = snapshot(db.models);
  assert.equal(listOffers(refreshed, new URLSearchParams(`${query}&max_cost_usd=5`)).meta.excluded_count, 0);
  assert.throws(() => listOffers(db, new URLSearchParams("profile=custom&input_tokens=100&output_tokens=1&cached_input_ratio=0.8&cache_write_tokens=80")), QueryInputError);
});

test("stale evidence and expired routes are excluded consistently from the available catalog", () => {
  const base = offer({ id: "route", providerId: "provider", providerModelId: "model", capabilities: { tools: true }, evidence: [evidence] });
  const db = snapshot([
    { id: "vendor/stale", identity_confidence: "exact", offers: [{ ...base, evidence: [{ ...evidence, status: "stale" }] }], evidence: [evidence] },
    { id: "vendor/expired", identity_confidence: "exact", offers: [{ ...base, expires_at: "2026-08-30" }], evidence: [evidence] },
  ]);
  assert.equal(listModels(db, new URLSearchParams()).meta.total, 0);
  assert.equal(listOffers(db, new URLSearchParams()).meta.total, 0);
  assert.equal(listProviders(db).length, 0);
  assert.equal(listFacets(db).capabilities.length, 0);
});

test("API errors are not cached and server failures do not expose internal messages", () => {
  const headers: Record<string, string> = {};
  let body: any;
  const response: ApiResponse = { status() { return response; }, setHeader(key, value) { headers[key] = value; return response; }, json(value) { body = value; }, end() {} };
  sendError(response, 500, "private filesystem path and upstream response");
  assert.equal(headers["cache-control"], "no-store");
  assert.equal(body.error.message, "unable to serve catalog");
  sendError(response, 400, "invalid id", "id");
  assert.equal(headers["cache-control"], "no-store");
  assert.equal(body.error.parameter, "id");
  sendJson(response, { data: [] });
  assert.match(headers["cache-control"], /public/);
});
