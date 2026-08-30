import assert from "node:assert/strict";
import test from "node:test";
import { mergeSnapshots } from "../src/merge.ts";
import { health as describeHealth } from "../src/query.ts";

import {
  DEFAULT_BASE,
  parseArgs,
  validateBundle,
} from "../.agents/skills/model-that-fits-my-task/scripts/download-snapshot.mjs";

const schema = { $defs: {}, properties: { schema_version: { const: "1.0" } } };
const timestamp = "2026-08-26T00:00:00.000Z";
const snapshot = mergeSnapshots(undefined, [{ source_id: "fixture", url: "https://fixture.example", fetched_at: timestamp,
  status: "ok", records: [{ id: "vendor/model" }] }], timestamp);
const health = describeHealth(snapshot);

test("snapshot downloader parses explicit output and base", () => {
  assert.deepEqual(parseArgs(["--out", "/tmp/models", "--base", "https://example.test/api/"]), {
    base: "https://example.test/api",
    out: "/tmp/models",
  });
  assert.equal(parseArgs(["--out", "/tmp/models"]).base, DEFAULT_BASE);
  assert.throws(() => parseArgs([]), /--out is required/);
});

test("snapshot downloader validates a matching bundle", () => {
  assert.deepEqual(validateBundle(health, schema, snapshot), {
    generated_at: snapshot.generated_at,
    schema_version: "1.0",
    content_hash: snapshot.content_hash,
    model_count: 1,
    source_count: 1,
  });
});

test("snapshot downloader rejects mismatched or unhealthy data", () => {
  assert.throws(() => validateBundle({ ...health, status: "empty" }, schema, snapshot), /health is not ok/);
  assert.throws(() => validateBundle({ ...health, model_count: 2 }, schema, snapshot), /model counts differ/);
  assert.throws(() => validateBundle({ ...health, content_hash: "f".repeat(64) }, schema, snapshot), /content hashes differ/);
  assert.throws(() => validateBundle(health, { ...schema, properties: { schema_version: { const: "2.0" } } }, snapshot), /versions differ/);
});

test("live snapshot and schema remain mutually consistent", { skip: process.env.LIVE_TESTS !== "1", timeout: 600_000 }, async () => {
  const { download } = await import("../.agents/skills/model-that-fits-my-task/scripts/download-snapshot.mjs");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "models-labyrinth-skill-"));
  try {
    const result = await download({ base: DEFAULT_BASE, out: directory });
    assert.ok(result.model_count > 0);
    assert.ok(result.source_count > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
