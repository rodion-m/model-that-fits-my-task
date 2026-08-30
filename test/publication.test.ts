import assert from "node:assert/strict";
import test from "node:test";
import { mergeSnapshots } from "../src/merge.js";
import { assertPublicationAllowed } from "../src/publication.js";

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
