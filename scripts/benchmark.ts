import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { cpus, platform, arch, release } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { loadSnapshot } from "../src/db.js";
import { comparisonLaneId, scoreDirection } from "../src/lane.js";
import { queryIndex } from "../src/query-index.js";
import { listBenchmarkObservations, listFacets, listModels, listOffers } from "../src/query.js";

const arguments_ = process.argv.slice(2);
function option(name: string): string | undefined {
  const index = arguments_.indexOf(name);
  if (index < 0) return undefined;
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
function count(name: string, defaultValue: number): number {
  const raw = option(name);
  if (raw === undefined) return defaultValue;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > 10000) throw new Error(`${name} must be between 1 and 10000`);
  return value;
}
const iterations = count("--iterations", 50);
const warmup = count("--warmup", 5);
const worker = option("--worker");

function statistics(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.ceil(sorted.length * p) - 1];
  return { samples: values.length, min_ms: sorted[0], p50_ms: percentile(0.5), p95_ms: percentile(0.95), max_ms: sorted.at(-1) };
}

if (worker) {
  if (!["archive", "runtime"].includes(worker)) throw new Error("worker must be archive or runtime");
  const filename = worker === "archive" ? "models_db.json" : "runtime-query.json";
  const artifactStat = statSync(filename);
  const rssBefore = process.memoryUsage().rss;
  const start = performance.now();
  const snapshot = loadSnapshot({ path: resolve(filename) });
  const loadMs = performance.now() - start;
  const indexStart = performance.now();
  const index = queryIndex(snapshot);
  const indexMs = performance.now() - indexStart;
  const ranked = index.observations.find((row) => {
    try { scoreDirection(row); return !["aggregate", "claim"].includes(row.kind ?? ""); }
    catch { return false; }
  });
  if (!ranked) throw new Error("benchmark requires a lane with a known score direction");
  const cases = [
    { name: "available_model_summaries", parameters: "view=summary&sort=context&limit=25", run: () => listModels(snapshot, new URLSearchParams("view=summary&sort=context&limit=25")) },
    { name: "available_offer_costs", parameters: "profile=chat-short&sort=cost&limit=25", run: () => listOffers(snapshot, new URLSearchParams("profile=chat-short&sort=cost&limit=25")) },
    { name: "available_facets", parameters: "scope=available", run: () => listFacets(snapshot) },
    { name: "one_lane_score_order", parameters: `scope=all&lane_id=${comparisonLaneId(ranked)}&sort=score&limit=25`, run: () => listBenchmarkObservations(snapshot, new URLSearchParams(`scope=all&lane_id=${comparisonLaneId(ranked)}&sort=score&limit=25`)) },
  ];
  const measurements = cases.map((entry) => {
    const firstStart = performance.now();
    entry.run();
    const firstQueryMs = performance.now() - firstStart;
    for (let index = 0; index < warmup; index += 1) entry.run();
    const queries = [];
    const serialization = [];
    let responseBytes = 0;
    for (let index = 0; index < iterations; index += 1) {
      const queryStart = performance.now();
      const result = entry.run();
      queries.push(performance.now() - queryStart);
      const serializationStart = performance.now();
      const json = JSON.stringify(result);
      serialization.push(performance.now() - serializationStart);
      responseBytes = Buffer.byteLength(json);
    }
    return { name: entry.name, parameters: entry.parameters, first_query_ms: firstQueryMs, query: statistics(queries), serialization: statistics(serialization), response_bytes: responseBytes };
  });
  const finalStat = statSync(filename);
  if (artifactStat.size !== finalStat.size || artifactStat.mtimeMs !== finalStat.mtimeMs || artifactStat.ino !== finalStat.ino) throw new Error(`${filename} changed during measurement`);
  console.log(JSON.stringify({ artifact: worker, artifact_bytes: artifactStat.size, artifact_mtime_ms: artifactStat.mtimeMs,
    content_hash: snapshot.content_hash, generated_at: snapshot.generated_at, model_count: snapshot.models.length,
    observation_count: index.observations.length, offer_count: index.offers.length,
    load_and_validate_ms: loadMs, build_index_ms: indexMs,
    rss_before_bytes: rssBefore, rss_after_bytes: process.memoryUsage().rss, peak_rss_bytes: process.resourceUsage().maxRSS * 1024,
    measurements,
  }));
} else {
  const results = ["archive", "runtime"].map((kind) => {
    const result = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--worker", kind,
      "--iterations", String(iterations), "--warmup", String(warmup)], { encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024 });
    if (result.status !== 0) throw new Error(result.stderr || result.error?.message || `benchmark ${kind} failed`);
    return JSON.parse(result.stdout);
  });
  if (results[0].content_hash !== results[1].content_hash || results[0].generated_at !== results[1].generated_at) throw new Error("archive/runtime generations differ; run npm run build:static first");
  const archive = JSON.parse(await readFile("models_db.json", "utf8"));
  if (archive.content_hash !== results[0].content_hash || archive.generated_at !== results[0].generated_at
    || statSync("runtime-query.json").mtimeMs !== results[1].artifact_mtime_ms) throw new Error("artifact generation changed during measurement");
  const report = { measured_at: new Date().toISOString(), node: process.version, tsx: JSON.parse(await readFile("node_modules/tsx/package.json", "utf8")).version,
    system: { platform: platform(), architecture: arch(), os_release: release(), cpu: cpus()[0]?.model },
    methodology: { isolated_process_per_artifact: true, os_page_cache: "not controlled; these are process-cold, not disk-cold measurements",
      percentile: "nearest rank", iterations, warmup_iterations: warmup, network_requests: 0,
      scope: "local catalog query implementation; not a model-quality benchmark or a serverless/CDN latency measurement" },
    archive_minified_bytes: Buffer.byteLength(JSON.stringify(archive)), results };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  const output = option("--output");
  if (output) await writeFile(resolve(output), text);
  console.log(text.trimEnd());
}
