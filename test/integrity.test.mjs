import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mergeSnapshots } from "../src/merge.ts";
import { health } from "../src/query.ts";
import { buildRuntimeQueryArtifact, snapshotFromRuntimeArtifact } from "../src/runtime-artifact.ts";
import { readSnapshot, writeSnapshotAtomic } from "../src/storage.ts";
import { assertSnapshotIntegrity, snapshotContentHash } from "../.agents/skills/model-that-fits-my-task/scripts/snapshot-integrity.mjs";
import { download, validateBundle } from "../.agents/skills/model-that-fits-my-task/scripts/download-snapshot.mjs";

const now = "2026-08-31T00:00:00.000Z";
const evidence = { source_id: "fixture", url: "https://fixture.example", fetched_at: now, status: "observed" };
const schema = { $defs: {}, properties: { schema_version: { const: "1.0" } } };
function fixture() {
  return mergeSnapshots(undefined, [{ source_id: "fixture", url: evidence.url, fetched_at: now, status: "ok",
    records: [{ id: "vendor/model", name: "Original", evidence: [evidence], benchmarks: [{ benchmark_id: "fixture.score", metric: "accuracy", value: -2, evidence }] }] }], now);
}
function fetcher(snapshot, calls = [], healthOverride) {
  return async (url) => {
    calls.push(String(url));
    const value = String(url).endsWith("health.json") ? healthOverride ?? health(snapshot) : String(url).endsWith("schema.json") ? schema : snapshot;
    return new Response(JSON.stringify(value));
  };
}

test("snapshot validation verifies content rather than trusting its declared digest", () => {
  const snapshot = fixture();
  assertSnapshotIntegrity(snapshot);
  const altered = structuredClone(snapshot);
  altered.models[0].name = "Tampered";
  assert.throws(() => assertSnapshotIntegrity(altered), /content_hash mismatch/);
  assert.throws(() => validateBundle(health(snapshot), schema, altered), /content_hash mismatch/);
  for (const mutate of [
    (value) => delete value.workload_profiles,
    (value) => delete value.models[0].runtime_observations,
    (value) => { value.models[0].capabilities.tools = "true"; },
    (value) => { value.models[0].benchmarks[0].sample_count = -1; },
    (value) => value.models.push(structuredClone(value.models[0])),
  ]) {
    const invalid = fixture();
    mutate(invalid);
    invalid.content_hash = snapshotContentHash(invalid);
    assert.throws(() => assertSnapshotIntegrity(invalid));
  }
});

test("runtime artifacts reject orphan observations and changed lane IDs instead of discarding data", () => {
  const snapshot = fixture();
  const artifact = buildRuntimeQueryArtifact(snapshot);
  assert.deepEqual(snapshotFromRuntimeArtifact(artifact), snapshot);
  const orphan = structuredClone(artifact);
  orphan.observations.push({ ...orphan.observations[0], model_id: "missing/model" });
  assert.throws(() => snapshotFromRuntimeArtifact(orphan), /unknown model/);
  artifact.observations[0].lane_id = "wrong";
  assert.throws(() => snapshotFromRuntimeArtifact(artifact), /lane mismatch/);
});

test("atomic snapshot writes reject invalid input and concurrent writers never share a temporary file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "models-integrity-"));
  try {
    const path = join(directory, "snapshot.json");
    const first = fixture();
    await writeSnapshotAtomic(path, first);
    await assert.rejects(writeSnapshotAtomic(path, { ...first, content_hash: "invalid" }), /SHA-256/);
    assert.equal((await readSnapshot(path)).content_hash, first.content_hash);
    const second = fixture();
    second.generated_at = "2026-08-31T01:00:00.000Z";
    await Promise.all([writeSnapshotAtomic(path, first), writeSnapshotAtomic(path, second)]);
    assertSnapshotIntegrity(await readSnapshot(path));
    assert.deepEqual(await readdir(directory), ["snapshot.json"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("downloader revalidates cached bytes and replaces corrupt cache with an observable result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "models-download-"));
  try {
    const snapshot = fixture();
    const calls = [];
    const options = { base: "https://fixture.example", out: directory, fetchImpl: fetcher(snapshot, calls) };
    const first = await download(options);
    const corrupted = structuredClone(snapshot);
    corrupted.models[0].name = "Changed without resealing";
    await writeFile(first.snapshot_path, JSON.stringify(corrupted));
    const repaired = await download(options);
    assert.equal(repaired.cache_status, "invalid");
    assert.match(repaired.cache_validation_error, /content_hash mismatch/);
    assert.equal(repaired.reused, false);
    assert.notEqual(repaired.snapshot_path, first.snapshot_path);
    assertSnapshotIntegrity(JSON.parse(await readFile(repaired.snapshot_path, "utf8")));
    assert.equal(calls.filter((url) => url.endsWith("snapshot.json")).length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("status-only generations invalidate the cache even when the content hash is unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "models-generation-"));
  try {
    const first = fixture();
    const next = structuredClone(first);
    next.generated_at = "2026-08-31T01:00:00.000Z";
    next.sources[0].status = "error";
    next.sources[0].error = "upstream unavailable";
    const original = await download({ base: "https://fixture.example", out: directory, fetchImpl: fetcher(first) });
    const refreshed = await download({ base: "https://fixture.example", out: directory, fetchImpl: fetcher(next) });
    assert.equal(original.content_hash, refreshed.content_hash);
    assert.equal(refreshed.cache_status, "outdated");
    assert.equal(refreshed.generated_at, next.generated_at);
    assert.equal(JSON.parse(await readFile(original.snapshot_path, "utf8")).sources[0].status, "ok");
    assert.equal(JSON.parse(await readFile(refreshed.snapshot_path, "utf8")).sources[0].status, "error");
    assert.throws(() => validateBundle(health(first), schema, next), /generations differ/);
    const wrongStatus = structuredClone(first);
    wrongStatus.sources[0].status = "error";
    assert.throws(() => validateBundle(health(first), schema, wrongStatus), /source statuses differ/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("concurrent downloads return immutable, internally consistent generation paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "models-concurrent-"));
  try {
    const first = fixture();
    const next = structuredClone(first);
    next.generated_at = "2026-08-31T01:00:00.000Z";
    next.models[0].name = "Next";
    next.content_hash = snapshotContentHash(next);
    const results = await Promise.all([first, next].map((snapshot) => download({ base: "https://fixture.example", out: directory, fetchImpl: fetcher(snapshot) })));
    assert.notEqual(results[0].snapshot_path, results[1].snapshot_path);
    for (const result of results) {
      const snapshot = JSON.parse(await readFile(result.snapshot_path, "utf8"));
      assert.equal(snapshot.content_hash, result.content_hash);
      assert.equal(snapshot.generated_at, result.generated_at);
      assertSnapshotIntegrity(snapshot);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
