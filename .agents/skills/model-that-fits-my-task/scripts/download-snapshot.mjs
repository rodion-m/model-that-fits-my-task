#!/usr/bin/env node

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertSnapshotIntegrity } from "./snapshot-integrity.mjs";
import { stableValue } from "./benchmark-semantics.mjs";

export const DEFAULT_BASE = "https://rodion-m.github.io/model-that-fits-my-task/api/v1";
const MANIFEST_FILE = "bundle.json";

export function parseArgs(argv) {
  const options = { base: DEFAULT_BASE, out: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") return { help: true };
    if (value !== "--base" && value !== "--out") throw new Error(`unknown argument: ${value}`);
    const next = argv[index + 1];
    if (!next) throw new Error(`${value} requires a value`);
    if (value === "--base") options.base = next.replace(/\/$/, "");
    else options.out = next;
    index += 1;
  }
  if (!options.out) throw new Error("--out is required");
  return options;
}

export function validateBundle(health, schema, snapshot) {
  validateHealth(health);
  if (!schema || typeof schema !== "object" || !schema.$defs) throw new Error("schema is not a Models Labyrinth JSON Schema");
  if (!snapshot || typeof snapshot !== "object") throw new Error("snapshot is not an object");
  if (snapshot.schema_version !== health.schema_version) throw new Error("health and snapshot schema versions differ");
  if (health.content_hash !== snapshot.content_hash) throw new Error("health and snapshot content hashes differ");
  if (health.generated_at !== snapshot.generated_at) throw new Error("health and snapshot generations differ");
  if (schema.properties?.schema_version?.const !== snapshot.schema_version) throw new Error("schema and snapshot versions differ");
  assertSnapshotIntegrity(snapshot);
  if (health.model_count !== snapshot.models.length) throw new Error("health and snapshot model counts differ");
  if (health.source_count !== snapshot.sources.length) throw new Error("health and snapshot source counts differ");
  const healthSources = health.sources.map(({ stale: _stale, ...source }) => source);
  if (JSON.stringify(stableValue(healthSources)) !== JSON.stringify(stableValue(snapshot.sources))) throw new Error("health and snapshot source statuses differ");
  return {
    generated_at: snapshot.generated_at,
    schema_version: snapshot.schema_version,
    content_hash: snapshot.content_hash,
    model_count: snapshot.models.length,
    source_count: snapshot.sources.length,
  };
}

function validateHealth(health) {
  if (!health || health.status !== "ok") throw new Error("catalog health is not ok");
  if (!/^[a-f0-9]{64}$/.test(health.content_hash ?? "") || health.schema_version !== "1.0"
    || !Number.isFinite(Date.parse(health.generated_at)) || !Array.isArray(health.sources)
    || !Number.isSafeInteger(health.model_count) || health.model_count < 0
    || !Number.isSafeInteger(health.source_count) || health.source_count < 0) throw new Error("catalog health identity is incomplete");
}

async function fetchJson(url, fetchImpl = fetch, timeoutMs = 120_000) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const text = await response.text();
  try {
    return { value: JSON.parse(text), text };
  } catch {
    throw new Error(`${url} did not return valid JSON`);
  }
}

async function writeAtomic(path, contents) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function reusableBundle(outputDirectory, health) {
  try {
    const manifest = JSON.parse(await readFile(resolve(outputDirectory, MANIFEST_FILE), "utf8"));
    if (manifest.content_hash !== health.content_hash || manifest.schema_version !== health.schema_version
      || manifest.generated_at !== health.generated_at) return { status: "outdated" };
    if (typeof manifest.generation !== "string" || !/^[a-f0-9-]{36}$/.test(manifest.generation)) throw new Error("cache generation is invalid");
    const paths = generationPaths(outputDirectory, manifest.generation);
    const [schemaText, snapshotText] = await Promise.all([
      readFile(paths.schema_path, "utf8"),
      readFile(paths.snapshot_path, "utf8"),
    ]);
    const summary = validateBundle(health, JSON.parse(schemaText), JSON.parse(snapshotText));
    return { status: "verified", summary, paths };
  } catch (error) {
    return error?.code === "ENOENT" ? { status: "missing" }
      : { status: "invalid", error: error instanceof Error ? error.message : String(error) };
  }
}

function generationPaths(outputDirectory, generation) {
  const directory = resolve(outputDirectory, "generations", generation);
  return { snapshot_path: resolve(directory, "snapshot.json"), schema_path: resolve(directory, "schema.json") };
}

export async function download({ base, out, fetchImpl = fetch }) {
  const outputDirectory = resolve(out);
  const healthResult = await fetchJson(`${base}/health.json`, fetchImpl);
  validateHealth(healthResult.value);
  const cached = await reusableBundle(outputDirectory, healthResult.value);
  if (cached.status === "verified") return { ...cached.summary, ...cached.paths, reused: true, cache_status: cached.status, output_directory: outputDirectory };

  const [schemaResult, snapshotResult] = await Promise.all([
    fetchJson(`${base}/schema.json`, fetchImpl),
    fetchJson(`${base}/snapshot.json`, fetchImpl),
  ]);
  const summary = validateBundle(healthResult.value, schemaResult.value, snapshotResult.value);
  // Each caller returns immutable generation paths. A concurrent publication can
  // change bundle.json without changing the files that this caller will read.
  const generation = randomUUID();
  const generationDirectory = resolve(outputDirectory, "generations", generation);
  const paths = generationPaths(outputDirectory, generation);
  await mkdir(generationDirectory, { recursive: true });
  try {
    await writeFile(paths.schema_path, `${schemaResult.text.trimEnd()}\n`, { encoding: "utf8", flag: "wx" });
    await writeFile(paths.snapshot_path, `${snapshotResult.text.trimEnd()}\n`, { encoding: "utf8", flag: "wx" });
    await writeAtomic(resolve(outputDirectory, MANIFEST_FILE), `${JSON.stringify({ ...summary, generation }, null, 2)}\n`);
  } catch (error) {
    await rm(generationDirectory, { recursive: true, force: true });
    throw error;
  }
  return { ...summary, ...paths, reused: false, cache_status: cached.status,
    ...(cached.error ? { cache_validation_error: cached.error } : {}), output_directory: outputDirectory };
}

function usage() {
  return "Usage: node scripts/download-snapshot.mjs --out <directory> [--base <api-base>]";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log(usage());
    else console.log(JSON.stringify(await download(options), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exitCode = 1;
  }
}
