import { strict as assert } from "node:assert";
import test from "node:test";
import { collectBenchLM } from "../src/sources/benchlm.js";
import { collectModelsDev } from "../src/sources/models-dev.js";
import { collectOpenRouter } from "../src/sources/openrouter.js";
import { collectArtificialAnalysis } from "../src/sources/artificial-analysis.js";
import { collectVals } from "../src/sources/vals.js";
import { collectLiveBench } from "../src/sources/livebench.js";
import { collectOpenAsrEnglishLongform, collectOpenAsrEnglishShortform, collectOpenAsrMultilingual } from "../src/sources/open-asr.js";
import { collectArtificialAnalysisSpeechToText, collectPipecatStt } from "../src/sources/speech.js";
import { collectExtractBench, collectParseBench } from "../src/sources/document-benchmarks.js";
import { collectArena, collectForecastBench } from "../src/sources/model-benchmarks.js";

const live = process.env.LIVE_TESTS === "1";

test("live OpenRouter catalog contract", { skip: !live }, async () => {
  const result = await collectOpenRouter({ includeEndpoints: false });
  assert.equal(result.status, "ok");
  assert.ok(result.records.length > 0);
});

test("live Models.dev catalog contract", { skip: !live }, async () => {
  const result = await collectModelsDev();
  assert.equal(result.status, "ok");
  assert.ok(result.records.length > 0);
});

test("live BenchLM snapshot contract", { skip: !live }, async () => {
  const result = await collectBenchLM();
  assert.equal(result.status, "ok");
  assert.ok(result.records.length > 0);
});

test("live Artificial Analysis contract is key-gated", { skip: !live || !process.env.AA_API_KEY }, async () => {
  const result = await collectArtificialAnalysis();
  assert.equal(result.status, "ok");
  assert.ok(result.records.length > 0);
});

test("live Artificial Analysis STT free contract is key-gated", { skip: !live || !process.env.AA_API_KEY }, async () => {
  const result = await collectArtificialAnalysisSpeechToText();
  assert.equal(result.status, "ok");
  assert.ok(result.records.length > 0);
  assert.ok(result.records.some((record) => (record.benchmarks?.length ?? 0) > 0));
});

test("live Pipecat STT README contract", { skip: !live }, async () => {
  const result = await collectPipecatStt();
  assert.equal(result.status, "ok");
  assert.ok(result.records.length > 0);
  assert.ok(result.records.some((record) => record.offers?.some((offer) => offer.runtime.length > 0)));
  assert.ok(result.records.some((record) => record.aliases?.some((value) => value.kind === "service_key")));
});

test("live Open ASR CSV contracts", { skip: !live }, async () => {
  const results = await Promise.all([
    collectOpenAsrMultilingual(),
    collectOpenAsrEnglishShortform(),
    collectOpenAsrEnglishLongform(),
  ]);
  for (const result of results) {
    assert.equal(result.status, "ok");
    assert.ok(result.records.length > 0);
    assert.ok((result.benchmark_definitions?.length ?? 0) > 0);
  }
  assert.ok(results[0].records.some((record) => record.benchmarks?.some((row) => row.configuration?.language === "de")));
});

test("live Vals static benchmark snapshot contract", { skip: !live }, async () => {
  const result = await collectVals();
  assert.equal(result.status, "ok");
  assert.ok(result.records.length > 0);
  assert.ok((result.benchmark_definitions?.length ?? 0) > 0);
  const observations = result.records.flatMap((record) => record.benchmarks ?? []);
  assert.ok(observations.some((row) => row.benchmark_id === "vals.rsi_index" && row.variant === undefined && typeof row.value === "number"));
  assert.ok(observations.some((row) => row.benchmark_id === "vals.poker_agent" && row.metric === "trueskill_rating" && row.unit === "rating"));
});

test("live LiveBench release table contract", { skip: !live }, async () => {
  const result = await collectLiveBench();
  assert.equal(result.status, "ok");
  assert.ok(result.records.length > 0);
  assert.ok((result.benchmark_definitions?.length ?? 0) > 0);
  const observations = result.records.flatMap((record) => record.benchmarks ?? []);
  assert.ok(observations.some((row) => row.evaluator === "livebench" && row.dataset_version));
  assert.ok(observations.some((row) => typeof row.metrics?.evaluation_cost_usd === "number"));
});

test("live Arena latest model leaderboard contract", { skip: !live, timeout: 120_000 }, async () => {
  const result = await collectArena();
  assert.equal(result.status, "ok");
  assert.ok(result.records.length > 0);
  assert.ok((result.benchmark_definitions?.length ?? 0) >= 10);
  const observations = result.records.flatMap((record) => record.benchmarks ?? []);
  assert.ok(observations.some((row) => row.evaluator === "arena" && row.metric === "elo" && row.sample_count !== undefined));
  assert.ok(observations.every((row) => row.configuration?.category === "overall"));
});

test("live ForecastBench baseline model leaderboard contract", { skip: !live, timeout: 30_000 }, async () => {
  const result = await collectForecastBench();
  assert.equal(result.status, "ok");
  assert.ok(result.records.length > 0);
  assert.equal(result.benchmark_definitions?.length, 3);
  const observations = result.records.flatMap((record) => record.benchmarks ?? []);
  assert.ok(observations.some((row) => row.evaluator === "forecastbench" && row.metric === "brier_index" && row.configuration?.tools === false));
  assert.ok(observations.every((row) => !/median forecast|random uniform|always 0|always 1/i.test(row.metrics?.source_model_name as string ?? "")));
});

test("live ParseBench CSV contract", { skip: !live }, async () => {
  const result = await collectParseBench();
  assert.equal(result.status, "ok");
  assert.ok(result.records.length > 0);
  assert.equal(result.benchmark_definitions?.[0].id, "document.parseBench");
  assert.ok(result.records.some((record) => record.benchmarks?.some((row) => row.variant === "tables")));
});

test("live ExtractBench CSV contract", { skip: !live }, async () => {
  const result = await collectExtractBench();
  assert.equal(result.status, "ok");
  assert.ok(result.records.length > 0);
  assert.equal(result.benchmark_definitions?.[0].id, "document.extractBench");
  assert.ok(result.records.some((record) => record.benchmarks?.some((row) => row.variant === "long" && typeof row.metrics?.latency_seconds_per_document === "number")));
});
