import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mergeSnapshots } from "../src/merge.js";
import { assertPublicationAllowed } from "../src/publication.js";
import { collectSources, refreshDatabase } from "../src/refresh.js";
import { readSnapshot, writeSnapshotAtomic } from "../src/storage.js";
import type { SourceAdapter } from "../src/sources/index.js";
import type { SourceResult } from "../src/types.js";

const initialTime = "2026-08-30T00:00:00.000Z";
const nextTime = "2026-08-30T12:00:00.000Z";

function source(sourceId: string, count: number): SourceResult {
  const url = `https://${sourceId}.example/catalog`;
  return {
    source_id: sourceId, url, fetched_at: initialTime, status: "ok",
    records: Array.from({ length: count }, (_, index) => ({
      id: `${sourceId}/model-${index}`,
      evidence: [{ source_id: sourceId, url, fetched_at: initialTime, status: "observed" }],
    })),
  };
}

function adapter(result: SourceResult): SourceAdapter {
  return { source_id: result.source_id, url: result.url, collect: async () => result };
}

test("a failed source retains its last successful count across truncated recovery attempts", async () => {
  const original = source("catalog", 4);
  const previous = mergeSnapshots(undefined, [original], initialTime);
  const failed: SourceResult = { ...original, fetched_at: nextTime, records: [], status: "error", error: "upstream unavailable" };
  const retained = mergeSnapshots(previous, [failed], nextTime);

  for (const count of [1, 0]) {
    const [result] = await collectSources(retained, [adapter(source("catalog", count))]);
    assert.equal(result.status, "error");
    assert.equal(result.replace_previous, false);
    assert.match(result.error ?? "", /previous projection was kept/);
    assert.equal(mergeSnapshots(retained, [result], nextTime).models.length, 4);
  }
});

test("a successful empty complete catalog is rejected even without a previous projection", async () => {
  const [result] = await collectSources(undefined, [adapter(source("catalog", 0))]);
  assert.equal(result.status, "error");
  assert.equal(result.replace_previous, false);

  const [incremental] = await collectSources(undefined, [adapter({ ...source("catalog", 0), replace_previous: false })]);
  assert.equal(incremental.status, "ok");
});

test("an invalid normalized source cannot replace retained data or prevent another source updating", async () => {
  const previous = mergeSnapshots(undefined, [source("invalid", 1), source("healthy", 1)], initialTime);
  const invalid = source("invalid", 1);
  invalid.records[0].context_tokens = -1;
  const healthy = source("healthy", 2);
  const results = await collectSources(previous, [adapter(invalid), adapter(healthy)]);
  assert.equal(results[0].status, "error");
  assert.match(results[0].error ?? "", /context_tokens/);
  assert.equal(results[1].status, "ok");
  const merged = mergeSnapshots(previous, results, nextTime);
  assert.ok(merged.models.some((model) => model.id === "invalid/model-0"));
  assert.equal(merged.models.filter((model) => model.id.startsWith("healthy/")).length, 2);
});

test("a partial refresh retains status for sources that were not attempted", () => {
  const first = source("first", 1);
  const second = source("second", 1);
  const previous = mergeSnapshots(undefined, [first, second], initialTime);
  const refreshed = mergeSnapshots(previous, [first], nextTime);
  assert.deepEqual(refreshed.sources, previous.sources);
});

test("refresh publishes every source except unlicensed Artificial Analysis evidence", async () => {
  const previousFlag = process.env.AA_REDISTRIBUTION_LICENSE_CONFIRMED;
  const directory = await mkdtemp(join(tmpdir(), "model-refresh-aa-"));
  try {
    delete process.env.AA_REDISTRIBUTION_LICENSE_CONFIRMED;
    const path = join(directory, "snapshot.json");
    const catalog = source("catalog", 4);
    const restricted = source("artificial_analysis", 6);
    await writeSnapshotAtomic(path, mergeSnapshots(undefined, [catalog, restricted], initialTime));
    const redacted = await refreshDatabase({ path, adapters: [adapter(catalog), adapter(restricted)], now: nextTime });
    assert.equal(redacted.snapshot.models.length, 4);
    assert.equal(redacted.snapshot.models.every((model) => model.id.startsWith("catalog/")), true);
    assert.equal(redacted.snapshot.sources.some((item) => item.source_id === "artificial_analysis" && item.record_count === 6), true);
    assert.equal(assertPublicationAllowed(redacted.snapshot).evidence_count, 0);

    await assert.rejects(
      () => refreshDatabase({ path: join(directory, "aa-only.json"), adapters: [adapter(restricted)], now: nextTime }),
      /after removing unlicensed Artificial Analysis evidence/,
    );
    assert.equal(await readSnapshot(join(directory, "aa-only.json")), undefined);

    process.env.AA_REDISTRIBUTION_LICENSE_CONFIRMED = "1";
    const retained = await refreshDatabase({ path, adapters: [adapter(catalog), adapter(restricted)], now: nextTime });
    assert.equal(retained.snapshot.models.length, 10);
    assert.equal(retained.snapshot.models.some((model) => model.id.startsWith("artificial_analysis/")), true);
  } finally {
    if (previousFlag === undefined) delete process.env.AA_REDISTRIBUTION_LICENSE_CONFIRMED;
    else process.env.AA_REDISTRIBUTION_LICENSE_CONFIRMED = previousFlag;
    await rm(directory, { recursive: true, force: true });
  }
});

test("status-only refresh changes are persisted even when model evidence is unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "model-refresh-"));
  try {
    const path = join(directory, "snapshot.json");
    const first = source("first", 1);
    const second = source("second", 1);
    const previous = mergeSnapshots(undefined, [first, second], initialTime);
    await writeSnapshotAtomic(path, previous);
    const failed: SourceResult = { ...second, fetched_at: nextTime, status: "error", records: [], error: "upstream unavailable" };
    const refreshed = await refreshDatabase({ path, adapters: [adapter(first), adapter(failed)], now: nextTime });
    assert.equal(refreshed.snapshot.content_hash, previous.content_hash);
    assert.equal(refreshed.changed, true);
    const stored = await readSnapshot(path);
    assert.equal(stored?.generated_at, nextTime);
    assert.equal(stored?.sources.find((item) => item.source_id === "second")?.status, "error");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
