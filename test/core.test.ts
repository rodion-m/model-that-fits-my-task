import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { clearSnapshotCache, loadSnapshot } from "../src/db.js";
import { canonicalModelId, splitOpenRouterVariant } from "../src/identity.js";
import { normalizeMillionPricing, normalizeOpenRouterPricing, normalizePortkeyPricing } from "../src/price.js";
import { mergeSnapshots } from "../src/merge.js";
import { listBenchmarks, listFacets, listModels, listOffers } from "../src/query.js";
import { collectSources, refreshDatabase } from "../src/refresh.js";
import { writeSnapshotAtomic } from "../src/storage.js";
import { MODELS_DB_SCHEMA, assertSnapshotShape } from "../src/schema.js";
import { collectOpenRouter } from "../src/sources/openrouter.js";
import { collectBenchGecko, collectCloudPrice } from "../src/sources/enrichment.js";
import { collectVals, parseValsBenchmarkPage, parseValsCatalog, parseValsRsiBundle } from "../src/sources/vals.js";
import { collectLiveBench, parseCategories, parseCsv, parseModelLinks } from "../src/sources/livebench.js";
import { collectOpenAsrMultilingual, collectOpenAsrEnglishShortform } from "../src/sources/open-asr.js";
import { collectArtificialAnalysisSpeechToText, collectPipecatStt, parsePipecatResults, parsePipecatServiceRegistry } from "../src/sources/speech.js";
import type { BenchmarkDefinition, Snapshot, SourceRecord, SourceResult } from "../src/types.js";

test("price normalization preserves dimensions, units, zero and variable values", () => {
  const openRouter = normalizeOpenRouterPricing({ prompt: "0.0000025", completion: "0", web_search: "0.0025", request: "-1", overrides: [{ utc_days: ["saturday"], prompt: "0.000001" }] });
  assert.equal(openRouter.find((value) => value.dimension === "input")?.unit, "token");
  assert.equal(openRouter.find((value) => value.dimension === "output")?.amount_usd_per_unit, 0);
  assert.equal(openRouter.find((value) => value.dimension === "request")?.amount_usd_per_unit, null);
  assert.equal(openRouter.find((value) => value.kind === "scheduled")?.schedule?.utc_days?.[0], "saturday");
  assert.equal(normalizeMillionPricing({ input: 2.5 }).find((value) => value.dimension === "input")?.unit, "million_tokens");
  assert.equal(normalizePortkeyPricing({ pricing_config: { pay_as_you_go: { request_token: { price: 100 } } } }).find((value) => value.dimension === "input")?.amount_usd_per_unit, 1);
});

test("identity strips only explicit routing variants and refuses fuzzy joins", () => {
  assert.deepEqual(splitOpenRouterVariant("openai/gpt-4o:free"), { baseId: "openai/gpt-4o", variant: "free" });
  assert.equal(canonicalModelId({ sourceId: "openrouter", rawId: "openai/gpt-4o:free", publisher: "openai" }).id, "openai/gpt-4o");
  assert.notEqual(canonicalModelId({ sourceId: "openrouter", rawId: "openai/gpt-4o-mini", publisher: "openai" }).id, "openai/gpt-4o");
  assert.match(canonicalModelId({ sourceId: "epoch", rawId: "epoch:GPT-4o", name: "GPT-4o" }).id, /^unresolved\/epoch\//);
});

test("merge keeps one model and one offer while retaining source observations", () => {
  const first = sourceRecord("models_dev", "openai/gpt-4o", "GPT-4o", "https://models.dev/catalog.json", "models_dev:openai:gpt-4o");
  const second = sourceRecord("openrouter", "openai/gpt-4o", "GPT-4o", "https://openrouter.ai/api/v1/models", "openrouter:openai:gpt-4o");
  first.offers![0].pricing = normalizeMillionPricing({ input: 2.5 });
  second.offers![0].pricing = normalizeOpenRouterPricing({ prompt: "0.0000025" });
  const snapshot = mergeSnapshots(undefined, [result("models_dev", [first]), result("openrouter", [second])], "2026-08-26T00:00:00.000Z");
  assert.equal(snapshot.models.length, 1);
  assert.equal(snapshot.models[0].offers.length, 1);
  assert.equal(snapshot.models[0].offers[0].pricing.length, 2);
  assert.equal(snapshot.models[0].evidence.length, 2);
});

test("benchmark aliases share one canonical identity without losing source provenance", () => {
  const record = sourceRecord("benchlm", "openai/gpt-4o", "GPT-4o", "https://benchlm.example", "offer");
  record.benchmarks = [
    { benchmark_id: "agentic.terminalBench21", value: 42, evidence: record.evidence![0] },
    { benchmark_id: "coding.terminalBench21", value: 42, evidence: record.evidence![0] },
    { benchmark_id: "terminalBench21", value: 42, evidence: record.evidence![0] },
    { benchmark_id: "vals.terminal-bench-2-1", value: 42, evidence: record.evidence![0] },
  ];
  const snapshot = mergeSnapshots(undefined, [result("benchlm", [record])], "2026-08-26T00:00:00.000Z");
  assert.equal(snapshot.models[0].benchmarks.length, 1);
  assert.equal(snapshot.models[0].benchmarks[0].benchmark_id, "coding.terminalBench21");
  assert.equal(snapshot.models[0].benchmarks[0].kind, "benchmark");
  assert.deepEqual(snapshot.models[0].benchmarks[0].source_benchmark_ids, ["agentic.terminalBench21", "coding.terminalBench21", "terminalBench21", "vals.terminal-bench-2-1"]);
  assert.equal(listBenchmarks(snapshot).length, 1);
  assert.deepEqual(listBenchmarks(snapshot)[0].aliases, ["agentic.terminalBench21", "terminalBench21", "vals.terminal-bench-2-1"]);
  assert.equal(listModels(snapshot, new URLSearchParams("benchmark=agentic.terminalBench21")).data.length, 1);
});

test("business benchmark definitions join their categorized observations", () => {
  const record = sourceRecord("benchlm", "openai/gpt-4o", "GPT-4o", "https://benchlm.example", "offer");
  record.benchmarks = [
    { benchmark_id: "agentic.gdpvalAa", value: 55, evidence: record.evidence![0] },
    { benchmark_id: "agentic.gdpvalAaNormalized", value: 60, evidence: record.evidence![0] },
    { benchmark_id: "multimodalGrounded.officeQaPro", value: 65, evidence: record.evidence![0] },
    { benchmark_id: "knowledge.healthBenchProfessional", value: 70, evidence: record.evidence![0] },
    { benchmark_id: "knowledge.healthBenchProfessionalRaw", value: 71, evidence: record.evidence![0] },
    { benchmark_id: "agentic.spreadsheetBench2", value: 75, evidence: record.evidence![0] },
    { benchmark_id: "agentic.aaAutomationBench", value: 80, evidence: record.evidence![0] },
    { benchmark_id: "agentic.aaTau3Banking", value: 85, evidence: record.evidence![0] },
  ];
  const source = result("benchlm", [record]);
  source.benchmark_definitions = [
    benchmarkDefinition("gdpvalAa", "GDPval-AA"),
    benchmarkDefinition("officeQaPro", "OfficeQA Pro"),
    benchmarkDefinition("healthBenchProfessional", "HealthBench Professional"),
    benchmarkDefinition("healthBenchProfessionalRaw", "HealthBench Professional (raw)"),
    benchmarkDefinition("spreadsheetBench2", "SpreadsheetBench 2"),
    benchmarkDefinition("aaAutomationBench", "AA AutomationBench"),
    benchmarkDefinition("aaTau3Banking", "AA Tau3 Banking"),
  ];

  const snapshot = mergeSnapshots(undefined, [source], "2026-08-26T00:00:00.000Z");
  assert.deepEqual(snapshot.benchmarks.map((value) => value.id), [
    "agentic.automationBench",
    "agentic.spreadsheetBench2",
    "agentic.tau3Bench",
    "knowledge.healthBenchProfessional",
    "multimodalGrounded.officeQaPro",
    "professional.gdpvalAa",
  ]);
  assert.deepEqual(snapshot.models[0].benchmarks.map((value) => [value.benchmark_id, value.metric]), [
    ["agentic.automationBench", undefined],
    ["agentic.spreadsheetBench2", undefined],
    ["agentic.tau3Bench", undefined],
    ["knowledge.healthBenchProfessional", undefined],
    ["knowledge.healthBenchProfessional", "raw_score"],
    ["multimodalGrounded.officeQaPro", undefined],
    ["professional.gdpvalAa", undefined],
    ["professional.gdpvalAa", "normalized_score"],
  ]);
  assert.equal(listBenchmarks(snapshot, new URLSearchParams("q=gdpvalAa"))[0]?.id, "professional.gdpvalAa");
  assert.equal(snapshot.models[0].benchmarks.find((value) => value.benchmark_id === "agentic.tau3Bench")?.variant, "banking");
  assert.equal(snapshot.models[0].benchmarks.find((value) => value.benchmark_id === "agentic.automationBench")?.evaluator, "artificial_analysis");
});

test("a refreshed raw benchmark replaces its old value while distinct source observations remain", () => {
  const oldRecord = sourceRecord("benchlm", "openai/gpt-4o", "GPT-4o", "https://benchlm.example", "offer");
  oldRecord.benchmarks = [{ benchmark_id: "coding.terminalBench21", value: 40, evidence: oldRecord.evidence![0] }];
  const previous = mergeSnapshots(undefined, [result("benchlm", [oldRecord])], "2026-08-26T00:00:00.000Z");
  const newRecord = sourceRecord("benchlm", "openai/gpt-4o", "GPT-4o", "https://benchlm.example", "offer");
  newRecord.benchmarks = [{ benchmark_id: "coding.terminalBench21", value: 42, evidence: { ...newRecord.evidence![0], fetched_at: "2026-08-26T12:00:00.000Z" } }];
  const current = mergeSnapshots(previous, [result("benchlm", [newRecord])], "2026-08-26T12:00:00.000Z");
  assert.deepEqual(current.models[0].benchmarks.map((value) => value.value), [42]);
});

test("source-specific benchmark evaluators remain distinct after identity canonicalization", () => {
  const record = sourceRecord("benchlm", "openai/gpt-4o", "GPT-4o", "https://benchlm.example", "offer");
  record.benchmarks = [
    { benchmark_id: "coding.sciCode", value: 42, evidence: record.evidence![0] },
    { benchmark_id: "coding.aaSciCode", value: 42, evidence: record.evidence![0] },
  ];
  const snapshot = mergeSnapshots(undefined, [result("benchlm", [record])], "2026-08-26T00:00:00.000Z");
  assert.equal(snapshot.models[0].benchmarks.length, 2);
  assert.deepEqual(snapshot.models[0].benchmarks.map((row) => row.evaluator).sort(), ["artificial_analysis", undefined].sort());
});

test("derived catalog scores are explicitly classified as aggregates", () => {
  const record = sourceRecord("benchlm", "openai/gpt-4o", "GPT-4o", "https://benchlm.example", "offer");
  record.benchmarks = [{ benchmark_id: "score.overallScore", value: 77, evidence: record.evidence![0] }];
  const snapshot = mergeSnapshots(undefined, [result("benchlm", [record])], "2026-08-26T00:00:00.000Z");
  assert.equal(snapshot.models[0].benchmarks[0].kind, "aggregate");
  assert.equal(listBenchmarks(snapshot, new URLSearchParams("kind=benchmark")).length, 0);
  assert.equal(listBenchmarks(snapshot, new URLSearchParams("kind=aggregate")).length, 1);
});

test("multiple metrics share a benchmark identity but remain distinct observations", () => {
  const record = sourceRecord("benchlm", "openai/gpt-4o", "GPT-4o", "https://benchlm.example", "offer");
  record.benchmarks = [
    { benchmark_id: "agentic.toolathlonVerified", value: 50, evidence: record.evidence![0] },
    { benchmark_id: "agentic.toolathlonVerifiedPass3", value: 70, evidence: record.evidence![0] },
  ];
  const snapshot = mergeSnapshots(undefined, [result("benchlm", [record])], "2026-08-26T00:00:00.000Z");
  assert.deepEqual(snapshot.models[0].benchmarks.map((value) => [value.benchmark_id, value.metric]), [
    ["agentic.toolathlonVerified", undefined],
    ["agentic.toolathlonVerified", "pass_at_3"],
  ]);
  assert.equal(listBenchmarks(snapshot).length, 1);
});

test("query filters nested offers, paginates and computes a transparent profile estimate", () => {
  const record = sourceRecord("models_dev", "openai/gpt-4o", "GPT-4o", "https://models.dev/catalog.json", "offer");
  record.offers![0].reasoning_efforts = ["low", "medium"];
  record.offers![0].pricing = normalizeMillionPricing({ input: 1, output: 2, cache_read: 0.2, cache_write: 1.1 }, "full_rate");
  const snapshot = mergeSnapshots(undefined, [result("models_dev", [record])], "2026-08-26T00:00:00.000Z");
  assert.equal(listModels(snapshot, new URLSearchParams("capability=tools&limit=1")).data.length, 1);
  const offers = listOffers(snapshot, new URLSearchParams("profile=rag-long-prefix&reasoning_effort=low"));
  assert.equal(offers.data.length, 1);
  assert.equal(offers.data[0].workload_profile_id, "rag-long-prefix");
  assert.equal(offers.data[0].workload_profile?.input_tokens, 25_000);
  assert.ok((offers.data[0].estimated_cost_usd ?? 0) > 0);
});

test("custom workload profile calculates exact task cost and rejects incomplete input", () => {
  const record = sourceRecord("models_dev", "openai/gpt-4o", "GPT-4o", "https://models.dev/catalog.json", "offer");
  record.offers![0].pricing = normalizeMillionPricing({ input: 1, output: 2, cache_read: 0.2 });
  const snapshot = mergeSnapshots(undefined, [result("models_dev", [record])], "2026-08-26T00:00:00.000Z");
  const params = new URLSearchParams("profile=custom&input_tokens=10000&output_tokens=300&cached_input_ratio=0.5&cache_write_tokens=0&requests_per_task=2&sort=cost");
  const offer = listOffers(snapshot, params).data[0];
  assert.equal(offer.estimated_cost_usd, 0.0132);
  assert.deepEqual(offer.workload_profile, {
    id: "custom",
    description: "Caller-supplied workload profile.",
    input_tokens: 10_000,
    cached_input_ratio: 0.5,
    cache_write_tokens: 0,
    output_tokens: 300,
    requests_per_task: 2,
  });
  assert.throws(() => listOffers(snapshot, new URLSearchParams("profile=custom&input_tokens=10000")), /output_tokens is required/);
  assert.throws(() => listOffers(snapshot, new URLSearchParams("sort=cost")), /requires profile/);
});

test("route filters use exact model and provider ids plus model modalities", () => {
  const openai = sourceRecord("models_dev", "openai/gpt-4o", "GPT-4o", "https://models.dev/catalog.json", "openai-offer");
  const router = sourceRecord("models_dev", "openai/gpt-4o-mini", "GPT-4o mini", "https://models.dev/catalog.json", "router-offer");
  router.offers![0].provider_id = "openrouter";
  openai.modalities!.input.push("image");
  const snapshot = mergeSnapshots(undefined, [result("models_dev", [openai, router])], "2026-08-26T00:00:00.000Z");

  assert.equal(listOffers(snapshot, new URLSearchParams("model=openai/gpt-4o&provider=openai&modality=input:image")).data.length, 1);
  assert.equal(listOffers(snapshot, new URLSearchParams("model=openai/gpt-4o&provider=open")).data.length, 0);
  assert.equal(listModels(snapshot, new URLSearchParams("provider=ai")).data.length, 0);
  assert.equal(listModels(snapshot, new URLSearchParams("modality=input:image&view=summary")).data[0]?.identity_confidence, "exact");
});

test("cost estimate is unknown when required token prices conflict or are missing", () => {
  const record = sourceRecord("models_dev", "openai/gpt-4o", "GPT-4o", "https://models.dev/catalog.json", "offer");
  record.offers![0].pricing = normalizeMillionPricing({ input: 1 });
  const snapshot = mergeSnapshots(undefined, [result("models_dev", [record])], "2026-08-26T00:00:00.000Z");
  const params = new URLSearchParams("profile=custom&input_tokens=1000&output_tokens=100");
  assert.equal(listOffers(snapshot, params).data[0].estimated_cost_usd, null);
});

test("selection navigation exposes facets, compact candidates, and offer-level gates", () => {
  const record = sourceRecord("models_dev", "openai/gpt-4o", "GPT-4o", "https://models.dev/catalog.json", "offer");
  record.offers![0].context_tokens = 128_000;
  record.offers![0].reasoning_efforts = ["low", "high"];
  record.offers![0].capabilities.structured_outputs = true;
  record.offers![0].quantization = "fp8";
  record.offers![0].runtime = [{ scope: "offer", throughput_tokens_per_second: { median: 80 }, evidence: record.evidence![0] }];
  record.offers![0].pricing = normalizeMillionPricing({ input: 1, output: 2, cache_read: 0.2 });
  const snapshot = mergeSnapshots(undefined, [result("models_dev", [record])], "2026-08-26T00:00:00.000Z");

  const facets = listFacets(snapshot);
  assert.ok(facets.capabilities.some((facet) => facet.value === "tools"));
  assert.ok(facets.reasoning_efforts.some((facet) => facet.value === "high"));
  assert.ok(facets.quantizations.some((facet) => facet.value === "fp8"));

  const summary = listModels(snapshot, new URLSearchParams("view=summary&capability=tools&capability=structured_outputs")).data[0] as any;
  assert.equal(summary.id, "openai/gpt-4o");
  assert.equal(summary.offer_count, 1);
  assert.equal(summary.offers, undefined);

  const offers = listOffers(snapshot, new URLSearchParams("capability=tools&min_context=100000&has_runtime=true&has_cache_pricing=true&quantization=fp8"));
  assert.equal(offers.data.length, 1);
  assert.equal(listOffers(snapshot, new URLSearchParams("min_context=200000")).data.length, 0);
});

test("failed refresh never overwrites a valid previous snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "models-db-test-"));
  const path = join(directory, "models_db.json");
  const previous = mergeSnapshots(undefined, [result("models_dev", [sourceRecord("models_dev", "openai/gpt-4o", "GPT-4o", "https://models.dev/catalog.json", "offer")])], "2026-08-26T00:00:00.000Z");
  await writeSnapshotAtomic(path, previous);
  const before = await readFile(path, "utf8");
  await assert.rejects(() => refreshDatabase({ path, adapters: [{ source_id: "broken", url: "https://example.invalid", collect: async () => ({ source_id: "broken", url: "https://example.invalid", fetched_at: "2026-08-26T01:00:00.000Z", status: "error", records: [], error: "offline" }) }] }));
  assert.equal(await readFile(path, "utf8"), before);
  await rm(directory, { recursive: true, force: true });
});

test("snapshot cache reloads the file after its TTL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "models-db-cache-test-"));
  const path = join(directory, "models_db.json");
  const first = mergeSnapshots(undefined, [result("models_dev", [sourceRecord("models_dev", "openai/gpt-4o", "GPT-4o", "https://models.dev/catalog.json", "first")])], "2026-08-26T00:00:00.000Z");
  const second = mergeSnapshots(first, [result("models_dev", [sourceRecord("models_dev", "openai/gpt-4o-mini", "GPT-4o mini", "https://models.dev/catalog.json", "second")])], "2026-08-26T01:00:00.000Z");
  let clock = 0;

  try {
    await writeSnapshotAtomic(path, first);
    const loadedFirst = loadSnapshot({ path, ttlMs: 1_000, now: () => clock });
    await writeSnapshotAtomic(path, second);
    assert.equal(loadSnapshot({ path, ttlMs: 1_000, now: () => clock }), loadedFirst);
    clock = 1_000;
    assert.ok(loadSnapshot({ path, ttlMs: 1_000, now: () => clock }).models.some((model) => model.name === "GPT-4o mini"));
  } finally {
    clearSnapshotCache();
    await rm(directory, { recursive: true, force: true });
  }
});

test("source parser accepts real OpenRouter-shaped payload with no endpoint fan-out", async () => {
  const calls: string[] = [];
  const payload = { data: [{ id: "openai/gpt-4o", canonical_slug: "openai/gpt-4o-20260801", name: "GPT-4o", context_length: 128000, architecture: { input_modalities: ["text"], output_modalities: ["text"] }, pricing: { prompt: "0.0000025", completion: "0.00001" }, supported_parameters: ["tools", "structured_outputs"], reasoning: { supported_efforts: ["low"] } }] };
  const collected = await collectOpenRouter({ includeEndpoints: false, fetchImpl: async (input) => { calls.push(String(input)); return new Response(JSON.stringify(payload), { status: 200 }); } });
  assert.equal(collected.status, "ok");
  assert.equal(collected.records.length, 1);
  assert.equal(collected.records[0].offers?.length, 0);
  assert.equal(collected.replace_previous, true);
  assert.equal(calls.length, 1);
});

test("Pipecat STT parser keeps provider/model slugs and streaming metrics", async () => {
  const readme = [
    "Benchmark results on 2 samples from the `smart-turn-data-v3.1-train` dataset.",
    "<!-- RESULTS_TABLE:START -->",
    "| Vendor | Model | Transcripts | Perfect | WER Mean | Pooled WER | TTFS Median | TTFS P95 | TTFS P99 |",
    "|--------|-------|-------------|---------|----------|------------|-------------|----------|----------|",
    "| Test Vendor | model-x | 99.0% | 80.0% | 2.50% | 2.00% | 280ms | 400ms | 500ms |",
    "| Broken | model-y | n/a | 80.0% | 2.50% | 2.00% | 280ms | 400ms | 500ms |",
    "<!-- RESULTS_TABLE:END -->",
  ].join("\n");
  const parsed = parsePipecatResults(readme);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.sampleCount, 2);
  assert.equal(parsed.dataset, "smart-turn-data-v3.1-train");
  assert.equal(parsed.skippedRows, 1);

  const services = [
    '"test_vendor_model_x": ServiceDefinition(',
    '  factory=create_test,',
    '  vendor="Test Vendor",',
    '  model_label="model-x",',
    '),',
  ].join("\n");
  await assert.rejects(collectPipecatStt({ fetchImpl: async (input) => new Response(String(input).endsWith("services.py") ? services : readme) }), /collection is incomplete/);
  const completeReadme = readme.split("\n").filter((line) => !line.startsWith("| Broken |")).join("\n");
  const collected = await collectPipecatStt({ fetchImpl: async (input) => new Response(String(input).endsWith("services.py") ? services : completeReadme) });
  assert.equal(collected.records.length, 1);
  assert.equal(collected.records[0].id, "test-vendor/model-x");
  assert.equal(collected.records[0].offers?.[0].provider_id, "test-vendor");
  assert.equal(collected.records[0].offers?.[0].runtime[0].metrics?.ttfs_p95_ms, 400);
  assert.equal(collected.records[0].benchmarks?.find((row) => row.metric === "semantic_wer_mean")?.value, 2.5);
  assert.equal(collected.records[0].aliases?.find((value) => value.kind === "service_key")?.id, "test_vendor_model_x");
  assert.equal(collected.records[0].benchmarks?.find((row) => row.metric === "semantic_wer_mean")?.metrics?.service_key, "test_vendor_model_x");
  assert.equal(collected.benchmark_definitions?.length, 4);
});

test("Pipecat registry preserves upstream service keys as aliases", () => {
  const registry = parsePipecatServiceRegistry([
    '"assemblyai_universal_3_5_pro": ServiceDefinition(',
    '  factory=create_assemblyai_universal_3_5_pro,',
    '  vendor="AssemblyAI",',
    '  model_label="universal-3-5-pro",',
    '),',
  ].join("\n"));
  assert.equal(registry.get("assemblyai\u0000universal-3-5-pro"), "assemblyai_universal_3_5_pro");
});

test("Open ASR adapters preserve per-language WER lanes and ignore unavailable RTFx", async () => {
  const multilingual = "model,Model size (B),RTFx,de_covost,fr_fleurs,Avg\norg/model,1.2,-1,4.5,5.5,5.0\n";
  const collected = await collectOpenAsrMultilingual({ fetchImpl: async () => new Response(multilingual) });
  assert.equal(collected.records[0].id, "org/model");
  assert.equal(collected.records[0].benchmarks?.length, 3);
  assert.equal(collected.records[0].benchmarks?.find((row) => row.benchmark_id.endsWith("de-covost"))?.configuration?.language, "de");
  assert.equal(collected.records[0].runtime_observations?.[0].metrics?.rtfx, undefined);

  const shortform = "model,Avg. WER,RTFx,Model size (B),License,AMI WER\norg/model,4.0,100,1.2,Open,3.0\n";
  const english = await collectOpenAsrEnglishShortform({ fetchImpl: async () => new Response(shortform) });
  assert.equal(english.records[0].open_weights, true);
  assert.equal(english.records[0].benchmarks?.find((row) => row.benchmark_id.endsWith("ami-wer"))?.configuration?.language, "en");
  assert.equal(english.records[0].runtime_observations?.[0].metrics?.rtfx, 100);
});

test("Artificial Analysis STT free adapter normalizes the overall WER index without inventing routes", async () => {
  const payload = {
    tier: "free",
    data: [{ id: "aa-1", name: "Universal-3.5 Pro, AssemblyAI", model_creator: { name: "AssemblyAI" }, aa_wer_index: 0.024 }],
  };
  const collected = await collectArtificialAnalysisSpeechToText({
    apiKey: "test-key",
    fetchImpl: async (input, init) => {
      assert.equal(String(input), "https://artificialanalysis.ai/api/v2/media/speech-to-text/models/free");
      assert.equal(new Headers(init?.headers).get("x-api-key"), "test-key");
      return new Response(JSON.stringify(payload));
    },
  });
  assert.equal(collected.records[0].id, "assemblyai/universal-3-5-pro");
  assert.equal(collected.records[0].offers?.length, 0);
  assert.equal(collected.records[0].benchmarks?.[0].value, 2.4);
  assert.equal(collected.records[0].benchmarks?.[0].unit, "percent");
  assert.equal(collected.benchmark_definitions?.[0].id, "artificial_analysis_stt.aa_wer_index");
});

test("OpenRouter propagates model expiration to provider offers", async () => {
  const payload = { data: [{ id: "openai/gpt-expiring", name: "GPT Expiring", expiration_date: "2026-09-01T00:00:00Z" }] };
  const collected = await collectOpenRouter({
    includeEndpoints: true,
    endpointCap: 1,
    fetchImpl: async (input) => String(input).includes("/endpoints")
      ? new Response(JSON.stringify({ data: { id: "openai/gpt-expiring", endpoints: [{ provider_name: "OpenAI", model_id: "openai/gpt-expiring" }] } }), { status: 200 })
      : new Response(JSON.stringify(payload), { status: 200 }),
  });

  assert.equal(collected.records[0].offers?.[0].expires_at, "2026-09-01T00:00:00Z");
});

test("OpenRouter preserves previous endpoint offers outside the refresh cap", async () => {
  const prior = sourceRecord("openrouter", "openai/gpt-4o", "GPT-4o", "https://openrouter.ai/model", "openrouter:provider:gpt-4o");
  prior.offers![0].evidence[0].source_id = "openrouter";
  const payload = { data: [{ id: "openai/gpt-4o", name: "GPT-4o", supported_parameters: ["tools"] }] };
  const collected = await collectOpenRouter({
    previous: { models: [prior as any] },
    includeEndpoints: true,
    endpointCap: 0,
    fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }),
  });
  assert.equal(collected.records[0].offers?.length, 1);
  assert.equal(collected.records[0].offers?.[0].id, "openrouter:provider:gpt-4o");
});

test("secondary catalog adapters follow their documented pagination", async () => {
  const calls: string[] = [];
  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("benchgecko.ai")) {
      const page = new URL(url).searchParams.get("page");
      return new Response(JSON.stringify({ data: [{ slug: `model-${page}`, name: `Model ${page}`, provider: "Test", scores: {} }], meta: { pages: 2 } }), { status: 200 });
    }
    const token = new URL(url).searchParams.get("next_token");
    return new Response(JSON.stringify({ data: [{ id: token ? "cloud-2" : "cloud-1", name: token ? "Cloud 2" : "Cloud 1" }], pagination: { has_next: !token, next_token: token ? undefined : "next-page" } }), { status: 200 });
  };
  const benchgecko = await collectBenchGecko({ fetchImpl });
  const cloudprice = await collectCloudPrice({ fetchImpl });
  assert.equal(benchgecko.records.length, 2);
  assert.equal(cloudprice.records.length, 2);
  assert.equal(calls.filter((url) => url.includes("benchgecko.ai")).length, 2);
  assert.equal(calls.filter((url) => url.includes("cloudprice.net")).length, 2);
});

test("Vals static snapshot parser extracts business benchmark results and run conditions", async () => {
  const view = {
    metadata: { benchmark: "Excel Modeling Benchmark", slug: "emb", benchmark_id: "emb", version: "1", updated: "2026-08-19", dataset_type: "private", industry: "finance", description: "Build financial models." },
    tasks: { overall: { "openai/gpt-5.6-sol": { accuracy: 72.3, latency: 900, stderr: 1.2, cost_per_test: 6.01, reasoning_effort: "max", temperature: 1, provider: "OpenAI" } } },
  };
  const page = valsPage(view);
  assert.deepEqual(parseValsCatalog('<a href="/benchmarks/emb">EMB</a><a href="/benchmarks/emb">duplicate</a>'), ["emb"]);
  assert.equal(parseValsBenchmarkPage(page).metadata.slug, "emb");
  const collected = await collectVals({
    benchmarkLimit: 1,
    fetchImpl: async (input) => new Response(String(input).endsWith("/benchmarks") ? '<a href="/benchmarks/emb">EMB</a>' : page, { status: 200 }),
  });
  assert.equal(collected.status, "ok");
  assert.equal(collected.records.length, 1);
  assert.deepEqual(collected.records[0].benchmarks?.[0], {
    benchmark_id: "vals.emb",
    value: 72.3,
    unit: "percent",
    metric: "score",
    effort: "max",
    evaluator: "vals",
    dataset_version: "1",
    metrics: { latency: 900, stderr: 1.2, cost_per_test: 6.01 },
    configuration: { temperature: 1, reasoning_effort: "max", provider: "OpenAI" },
    evidence: collected.records[0].benchmarks?.[0].evidence,
  });
  assert.equal(collected.benchmark_definitions?.[0].category, "finance");
});

test("Vals RSI custom bundle is parsed as an explicit normalized index", async () => {
  const bundle = 'const H=["openai/gpt-test"],D={"openai/gpt-test":{compression:.5,post_training:0}},z=[{key:"compression",models:{"openai/gpt-test":{score:.5,result:"1.4 BPB",status:"valid",experiments:2,tokens:"1M",api_cost_usd:3.5}}}],G={models:H,capability:D,tasks:z},U={"openai/gpt-test":{harness:"Codex",effort:"max",headline:"Methodical"}};';
  const html = '<meta name="description" content="AI research"><div>Updated 8/12/2026</div><astro-island component-url="/_astro/RsiBenchmarkView.test.js" props="{}"></astro-island>';
  const parsed = parseValsRsiBundle(bundle, html);
  assert.deepEqual(parsed.tasks.overall["openai/gpt-test"], {
    value: 0.25,
    metric: "normalized_score",
    unit: "fraction",
    derived: true,
    reasoning_effort: "max",
    harness: "Codex",
  });
  const collected = await collectVals({
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("/benchmarks")) return new Response('<a href="/benchmarks/rsi_index">RSI</a>');
      if (url.endsWith(".js")) return new Response(bundle);
      return new Response(html);
    },
  });
  assert.equal(collected.warnings?.length ?? 0, 0);
  assert.equal(collected.benchmark_definitions?.[0].kind, undefined);
  assert.equal(collected.benchmark_definitions?.[0].updated_at, "2026-08-12");
  assert.equal(collected.records[0].benchmarks?.[0].metric, "normalized_score");
  assert.equal(collected.records[0].benchmarks?.[0].unit, "fraction");
  assert.equal(collected.records[0].benchmarks?.[0].evidence.status, "derived");
  assert.equal(collected.records[0].benchmarks?.find((row) => row.variant === "compression")?.metrics?.api_cost_usd, 3.5);
});

test("Vals keeps non-percent metrics explicit and does not promote unmatched systems to exact models", async () => {
  const view = {
    metadata: { benchmark: "Agent Poker Bench", slug: "poker_agent", benchmark_id: "poker_agent", version: "1", dataset_type: "private", industry: "beta", accuracy_label: "TrueSkill Rating" },
    tasks: { overall: { "grok/grok-4.6": { accuracy: 1131.8, cost_per_test: 0.01 } } },
  };
  const staleVals = sourceRecord("vals", "grok/grok-4.6", "Grok duplicate", "https://www.vals.ai/benchmarks", "unused");
  staleVals.offers = [];
  const previous = mergeSnapshots(undefined, [
    result("models_dev", [sourceRecord("models_dev", "x-ai/grok-4.6", "Grok 4.6", "https://models.dev", "offer")]),
    result("vals", [staleVals]),
  ], "2026-08-26T00:00:00.000Z");
  const collected = await collectVals({
    previous,
    fetchImpl: async (input) => new Response(String(input).endsWith("/benchmarks") ? '<a href="/benchmarks/poker_agent">Poker</a>' : valsPage(view)),
  });
  assert.match(collected.records[0].id, /^unresolved\/vals\//);
  assert.equal(collected.records[0].identity_confidence, "unresolved");
  assert.equal(collected.records[0].benchmarks?.[0].metric, "trueskill_rating");
  assert.equal(collected.records[0].benchmarks?.[0].unit, "rating");
});

test("Vals preserves task-specific professional benchmark metric semantics", async () => {
  const views: Record<string, Record<string, unknown>> = {
    programbench: { metadata: { benchmark: "ProgramBench", slug: "programbench" }, tasks: { overall: { "openai/gpt-test": { accuracy: 3 } }, partial: { "openai/gpt-test": { accuracy: 82 } } } },
    hlab: { metadata: { benchmark: "HLAB", slug: "hlab", benchmark_id: "legal_agent_benchmark" }, tasks: { overall: { "openai/gpt-test": { accuracy: 25 } }, criteria_pass_rate: { "openai/gpt-test": { accuracy: 98 } } } },
    time_horizon_index: { metadata: { benchmark: "Time Horizon", slug: "time_horizon_index" }, tasks: { overall: { "openai/gpt-test": { accuracy: 13.7 } } } },
  };
  const collected = await collectVals({
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("/benchmarks")) return new Response(Object.keys(views).map((slug) => `<a href="/benchmarks/${slug}">${slug}</a>`).join(""));
      return new Response(valsPage(views[url.split("/").at(-1)!]));
    },
  });
  const observations = collected.records[0].benchmarks ?? [];
  assert.equal(observations.find((row) => row.benchmark_id === "vals.programbench" && row.variant === undefined)?.metric, "fully_resolved_rate");
  assert.equal(observations.find((row) => row.benchmark_id === "vals.programbench" && row.variant === "partial")?.metric, "raw_pass_rate");
  assert.equal(observations.find((row) => row.benchmark_id === "vals.hlab" && row.variant === "criteria_pass_rate")?.metric, "criteria_pass_rate");
  assert.equal(observations.find((row) => row.benchmark_id === "vals.time_horizon_index")?.metric, "mission_progress");
});

test("LiveBench parser preserves release, effort, subtask, and evaluation-cost semantics", async () => {
  const constants = 'export const RELEASES = ["2025-11-25", "2026-06-25"];';
  const categories = JSON.stringify({ Reasoning: ["logic"], Coding: ["code_generation"] });
  const table = [
    "model,logic,code_generation",
    "gpt-5.6-sol-max,80,90",
    "grok-4.6,70,85",
  ].join("\n");
  const cost = [
    "model,logic,code_generation,nq_logic,nq_code_generation,avg_input_tokens,avg_output_tokens,input_price_per_million,output_price_per_million,cost_per_question,cost_per_successful_task",
    "gpt-5.6-sol-max,2.4,3.6,10,10,1000,200,1,2,0.3,0.5",
  ].join("\n");
  const links = `export const modelLinks = {
    "gpt-5.6-sol-max": {
        url: "https://platform.openai.com/docs/models/gpt-5.6",
        organization: "OpenAI",
        displayName: "GPT-5.6 Sol Max Effort",
        reasoner: true,
       variants: [{ rawName: "gpt-5.6-sol-xhigh", displayName: "GPT-5.6 Sol xHigh Effort" }]
   },
    "gpt-5.4-high": { organization: "OpenAI", displayName: "GPT-5.4" },
   "grok-4.6": { organization: "xAI", displayName: "Grok 4.6", reasoner: true }
};`;
  assert.deepEqual(parseCsv('model,a\n"x,y",1\n').rows[0], { model: "x,y", a: "1" });
  assert.deepEqual(parseCategories(categories), { Reasoning: ["logic"], Coding: ["code_generation"] });
  assert.equal(parseModelLinks(links).get("gpt-5.6-sol-xhigh")?.effort, "xhigh");
 assert.equal(parseModelLinks(links).get("gpt-5.6-sol-xhigh")?.display_name, "GPT-5.6 Sol xHigh Effort");
  assert.equal(parseModelLinks(links).get("gpt-5.4-high")?.effort, "high");

  const payloads = new Map([
    ["src/lib/constants.js", constants],
    ["public/table_2026_06_25.csv", table],
    ["public/categories_2026_06_25.json", categories],
    ["public/cost_2026_06_25.csv", cost],
    ["src/Table/modelLinks.js", links],
  ]);
  const result = await collectLiveBench({
    fetchImpl: async (input) => {
      const key = [...payloads.keys()].find((suffix) => String(input).endsWith(suffix));
      return new Response(key ? payloads.get(key) : "not found", { status: key ? 200 : 404 });
    },
  });
  assert.equal(result.status, "ok");
  assert.equal(result.replace_previous, true);
  assert.equal(result.records.length, 2);
  assert.ok(result.benchmark_definitions?.some((definition) => definition.id === "livebench.logic" && definition.version === "2026-06-25"));
  const openai = result.records.find((record) => record.id === "openai/gpt-5.6-sol");
  assert.equal(openai?.name, "GPT-5.6 Sol");
  const logic = openai?.benchmarks?.find((observation) => observation.benchmark_id === "livebench.logic");
  assert.equal(logic?.effort, "max");
  assert.equal(logic?.dataset_version, "2026-06-25");
  assert.equal(logic?.metrics?.evaluation_cost_usd, 2.4);
  assert.equal(logic?.metrics?.question_count, 10);
  assert.equal(logic?.metrics?.cost_per_question_usd, 0.24);
 assert.equal(openai?.benchmarks?.find((observation) => observation.benchmark_id === "livebench.overall")?.kind, "aggregate");
 assert.equal(result.records.find((record) => record.name === "Grok 4.6")?.id, "x-ai/grok-4.6");
  const withoutCost = await collectLiveBench({
    fetchImpl: async (input) => {
      const key = [...payloads.keys()].find((suffix) => String(input).endsWith(suffix));
      if (key?.startsWith("public/cost_")) return new Response("not found", { status: 404 });
      return new Response(key ? payloads.get(key) : "not found", { status: key ? 200 : 404 });
    },
  });
  assert.equal(withoutCost.status, "ok");
  assert.equal(withoutCost.warnings?.length, 1);
});

test("source replacement removes stale Vals-only models and canonical definitions keep their first authoritative fields", () => {
  const staleVals = sourceRecord("vals", "grok/grok-4.6", "Grok duplicate", "https://www.vals.ai/benchmarks", "unused");
  staleVals.offers = [];
  const previous = mergeSnapshots(undefined, [{ ...result("vals", [staleVals]), benchmark_definitions: [{ id: "vals.swebench", name: "SWE-bench", evidence: staleVals.evidence![0] }] }], "2026-08-26T00:00:00.000Z");
  const currentVals: SourceResult = { ...result("vals", []), replace_previous: true, records: [] };
  const benchlm: SourceResult = {
    ...result("benchlm", []),
    benchmark_definitions: [{ id: "sweVerified", name: "SWE-bench Verified", url: "https://benchlm.example/swe", evidence: { source_id: "benchlm", url: "https://benchlm.example/swe", fetched_at: "2026-08-26T01:00:00.000Z", status: "observed" } }],
  };
  const valsDefinition: SourceResult = {
    ...currentVals,
    benchmark_definitions: [{ id: "vals.swebench", name: "SWE-bench", url: "https://www.vals.ai/benchmarks/swebench", evidence: { source_id: "vals", url: "https://www.vals.ai/benchmarks/swebench", fetched_at: "2026-08-26T01:00:00.000Z", status: "observed" } }],
  };
  const snapshot = mergeSnapshots(previous, [benchlm, valsDefinition], "2026-08-26T01:00:00.000Z");
  assert.equal(snapshot.models.some((model) => model.id === "grok/grok-4.6"), false);
  assert.equal(snapshot.benchmarks[0].name, "SWE-bench Verified");
  assert.equal(snapshot.benchmarks[0].url, "https://benchlm.example/swe");
});

test("complete source collections replace by default while suspicious drops preserve previous data", async () => {
  const collected = await collectSources(undefined, [{
    source_id: "fixture",
    url: "https://fixture.example",
    collect: async () => result("fixture", [sourceRecord("fixture", "vendor/a", "A", "https://fixture.example", "a")]),
  }]);
  assert.equal(collected[0].replace_previous, true);

  const explicitlyIncremental = await collectSources(undefined, [{
    source_id: "fixture",
    url: "https://fixture.example",
    collect: async () => ({ ...result("fixture", []), replace_previous: false }),
  }]);
  assert.equal(explicitlyIncremental[0].replace_previous, false);

  const previous = mergeSnapshots(undefined, [result("fixture", [
    sourceRecord("fixture", "vendor/a", "A", "https://fixture.example", "a"),
    sourceRecord("fixture", "vendor/b", "B", "https://fixture.example", "b"),
    sourceRecord("fixture", "vendor/c", "C", "https://fixture.example", "c"),
  ])], "2026-08-26T00:00:00.000Z");
  const guarded = await collectSources(previous, [{
    source_id: "fixture",
    url: "https://fixture.example",
    collect: async () => result("fixture", [sourceRecord("fixture", "vendor/a", "A", "https://fixture.example", "a")]),
  }]);
  assert.equal(guarded[0].status, "error");
  assert.match(guarded[0].error ?? "", /previous projection was kept/);
});

test("schema describes the snapshot and requires a verified content hash", () => {
  assert.equal(MODELS_DB_SCHEMA.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(MODELS_DB_SCHEMA.$defs.api_meta.properties.scope.enum, ["available", "all"]);
  assert.ok(MODELS_DB_SCHEMA.$defs.comparison_lane.properties.lane_id);
  assert.throws(() => assertSnapshotShape({ schema_version: "1.0", generated_at: "2026-08-26T00:00:00.000Z", content_hash: "", workload_profiles: [], sources: [], benchmarks: [], models: [] } satisfies Snapshot), /SHA-256/);
  assertSnapshotShape(mergeSnapshots(undefined, [], "2026-08-26T00:00:00.000Z"));
});

function result(sourceId: string, records: SourceRecord[]): SourceResult {
  return { source_id: sourceId, url: `https://${sourceId}.example`, fetched_at: "2026-08-26T00:00:00.000Z", status: "ok", records };
}

function benchmarkDefinition(id: string, name: string): BenchmarkDefinition {
  return {
    id,
    name,
    evidence: { source_id: "benchlm", url: "https://benchlm.example", fetched_at: "2026-08-26T00:00:00.000Z", status: "observed" },
  };
}

function sourceRecord(sourceId: string, rawId: string, name: string, url: string, offerId: string): SourceRecord {
  const id = rawId.toLowerCase();
  return {
    id,
    identity_confidence: "exact",
    name,
    release_date: "2026-01-01",
    creators: [rawId.split("/")[0]],
    aliases: [{ id: rawId, source_id: sourceId }],
    open_weights: null,
    modalities: { input: ["text"], output: ["text"] },
    capabilities: { tools: true, structured_outputs: true },
    reasoning: [],
    offers: [{ id: offerId, provider_id: "openai", provider_name: "OpenAI", provider_model_id: rawId, status: "active", supported_parameters: ["tools"], capabilities: { tools: true }, reasoning_efforts: [], pricing: [], runtime: [], measurements: [], evidence: [{ source_id: sourceId, url, fetched_at: "2026-08-26T00:00:00.000Z", status: "observed" }] }],
    benchmarks: [],
    pricing_observations: [],
    runtime_observations: [],
    measurements: [],
    evidence: [{ source_id: sourceId, url, fetched_at: "2026-08-26T00:00:00.000Z", status: "observed" }],
  };
}

function valsPage(view: Record<string, unknown>): string {
  const props = JSON.stringify({ benchmarkView: astroEncode(view) }).replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  return `<astro-island component-url="/_astro/BenchmarkView.test.js" props="${props}"></astro-island>`;
}

function astroEncode(value: unknown): unknown {
  if (Array.isArray(value)) return [1, value.map(astroEncode)];
  if (value && typeof value === "object") return [0, Object.fromEntries(Object.entries(value).map(([key, child]) => [key, astroEncode(child)]))];
  return [0, value];
}
