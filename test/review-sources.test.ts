import assert from "node:assert/strict";
import test from "node:test";
import { collectModelsDev } from "../src/sources/models-dev.js";
import { collectOpenRouter } from "../src/sources/openrouter.js";
import { collectBenchGecko, collectCloudPrice, collectPortkey } from "../src/sources/enrichment.js";
import { collectArtificialAnalysis } from "../src/sources/artificial-analysis.js";
import { collectArena } from "../src/sources/model-benchmarks.js";
import { collectVals } from "../src/sources/vals.js";
import { collectLiveBench } from "../src/sources/livebench.js";
import { collectPipecatStt, parsePipecatResults } from "../src/sources/speech.js";
import { redactUrl, runtimeFromEndpoint } from "../src/source-utils.js";
import { fetchJson, mapWithConcurrency } from "../src/http.js";
import { mergeSnapshots } from "../src/merge.js";
import { comparisonLaneId } from "../src/lane.js";
import { normalizeMillionPricing, normalizeOpenRouterPricing, normalizePortkeyPricing } from "../src/price.js";
import { estimateWorkloadCost } from "../src/cost.js";
import { offer } from "../src/sources/common.js";

const json = (value: unknown) => new Response(JSON.stringify(value));
const at = "2026-08-31T00:00:00.000Z";
const evidence = { source_id: "fixture", url: "https://fixture.example", fetched_at: at, status: "observed" as const };

test("Models.dev preserves independent capability flags, reasoning controls and deprecated routes", async () => {
  const result = await collectModelsDev({ fetchImpl: async () => json({ providers: { vendor: { models: {
    model: { id: "model", tool_call: true, structured_output: false, status: "deprecated", reasoning: true,
      reasoning_options: [{ type: "effort", values: ["low", "high"] }, { type: "budget_tokens", min: 1024 }] },
  } } } }) });
  const model = result.records[0];
  assert.equal(model.capabilities?.structured_outputs, false);
  assert.equal(model.capabilities?.tools, true);
  assert.equal(model.offers?.[0].status, "absent");
  assert.deepEqual(model.offers?.[0].reasoning_efforts, ["high", "low"]);
  assert.equal(model.reasoning?.[0].supported, true);
  assert.ok(model.reasoning?.[0].controls?.includes("budget_tokens"));
});

test("Models.dev cannot join unrelated router names or choose the first suffix collision", async () => {
  const result = await collectModelsDev({ fetchImpl: async () => json({
    models: { "other/colliding": { id: "other/colliding" }, "vendor/colliding": { id: "vendor/colliding" } },
    providers: { vendor: { models: { colliding: { id: "colliding" } } }, alpha: { models: { auto: { id: "auto" } } }, beta: { models: { auto: { id: "auto" } } } },
  }) });
  assert.equal(result.records.find((model) => model.id === "vendor/colliding")?.offers?.length, 1);
  assert.equal(result.records.find((model) => model.id === "other/colliding")?.offers?.length, 0);
  assert.equal(result.records.find((model) => model.id === "alpha/auto")?.offers?.length, 1);
  assert.equal(result.records.find((model) => model.id === "beta/auto")?.offers?.length, 1);
});

test("OpenRouter uptime percentages become fractions and malformed endpoint data preserves offers", async () => {
  for (const percent of [0, 99.5, 100]) {
    assert.equal(runtimeFromEndpoint("openrouter", evidence.url, at, { uptime_last_30m: percent }).uptime_fraction?.value, percent / 100);
  }
  assert.throws(() => runtimeFromEndpoint("openrouter", evidence.url, at, { uptime_last_30m: 101 }), /percentage/);
  const previousOffer = offer({ id: "openrouter:vendor:vendor/model:default:fp16", providerId: "vendor", providerModelId: "vendor/model", evidence: [{ ...evidence, source_id: "openrouter", url: "https://openrouter.ai/api/v1/models/vendor/model/endpoints" }] });
  const result = await collectOpenRouter({ includeEndpoints: true, previous: { models: [{ id: "vendor/model", offers: [previousOffer] }] }, fetchImpl: async (input) => String(input).includes("/endpoints") ? json({ data: { changed: true } }) : json({ data: [{ id: "vendor/model", name: "Model", architecture: {} }] }) });
  assert.equal(result.warnings?.length, 1);
  assert.ok(result.records[0].offers?.some((row) => row.id === previousOffer.id));
});

test("OpenRouter endpoint caps rotate through empty and failed endpoint catalogs", async () => {
  const visited: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/endpoints")) {
      visited.push(url);
      return url.includes("vendor/a/") ? new Response("unavailable", { status: 503 }) : json({ data: { id: `vendor/${url.split("/").at(-2)}`, endpoints: [] } });
    }
    return json({ data: ["vendor/c", "vendor/a", "vendor/b"].map((id) => ({ id, name: id, architecture: {} })) });
  };
  let previous;
  for (let index = 0; index < 3; index += 1) {
    const result = await collectOpenRouter({ fetchImpl, previous, includeEndpoints: true, endpointCap: 1 });
    previous = mergeSnapshots(previous, [result]);
  }
  assert.deepEqual(visited.map((url) => url.split("/").at(-2)), ["a", "b", "c"]);
});

test("OpenRouter listing time and tokenizer do not invent a model release date or family", async () => {
  const result = await collectOpenRouter({ includeEndpoints: false, fetchImpl: async () => json({ data: [
    { id: "vendor/model", name: "Model", created: 1788048000, architecture: { tokenizer: "GPT" } },
  ] }) });
  assert.equal(result.records[0].release_date, undefined);
  assert.equal(result.records[0].family, undefined);
  assert.match(result.records[0].evidence![0].note!, /added_at=.*tokenizer=GPT/);
});

test("OpenRouter rejects cross-release endpoint resolution and removes previously misattributed routes", async () => {
  const requested = "vendor/model-preview";
  const canonical = "vendor/model-preview-06-05";
  const foreign = "vendor/model";
  const prior = offer({ id: "misattributed-route", providerId: "provider", providerModelId: foreign,
    evidence: [{ ...evidence, source_id: "openrouter" }] });
  for (const [resolved, endpoint, accepted] of [[foreign, foreign, false], [canonical, foreign, false], [canonical, canonical, true], [requested, requested, true]] as const) {
    const result = await collectOpenRouter({ includeEndpoints: true,
      previous: { models: [{ id: requested, offers: [prior] }] },
      fetchImpl: async (input) => String(input).includes("/endpoints")
        ? json({ data: { id: resolved, endpoints: [{ provider_name: "Provider", model_id: endpoint }] } })
        : json({ data: [{ id: requested, canonical_slug: canonical }] }),
    });
    assert.equal(result.records[0].offers?.length, accepted ? 1 : 0);
    assert.ok(!result.records[0].offers?.some((route) => route.id === prior.id));
    if (!accepted) assert.ok(result.warnings?.some((warning) => warning.includes("identity mismatch")));
  }
});

test("later OpenRouter context overrides shadow only the matching scheduled price keys", () => {
  const calculate = (overrides: unknown[], inputTokens = 100, outputTokens = 10) => estimateWorkloadCost(
    offer({ id: "route", providerId: "provider", providerModelId: "model", evidence: [evidence],
      pricing: normalizeOpenRouterPricing({ prompt: "0.000001", completion: "0.000001", overrides }) }),
    { id: "custom", description: "scheduled overrides", input_tokens: inputTokens, output_tokens: outputTokens, cached_input_ratio: 0, requests_per_task: 1 });
  const timed = { utc_start: 0, utc_end: 100, prompt: "0.000003" };
  const unconditional = { prompt: "0.000002" };
  assert.equal(calculate([timed, unconditional]).estimated_cost_usd, 0.00021);
  assert.equal(calculate([unconditional, timed]).estimated_cost_usd, null);
  const perKey = calculate([{ ...timed, completion: "0.000004" }, unconditional]);
  assert.equal(perKey.components.input, 0.0002);
  assert.equal(perKey.estimated_cost_usd, null);
  assert.ok(perKey.missing_dimensions.includes("output_tier"));
  const partial = [{ ...timed, min_prompt_tokens: 100 }, { ...unconditional, min_prompt_tokens: 200 }];
  assert.equal(calculate(partial, 100, 0).estimated_cost_usd, 0.0001);
  assert.equal(calculate(partial, 101, 0).estimated_cost_usd, null);
  assert.equal(calculate(partial, 200, 0).estimated_cost_usd, null);
  assert.equal(calculate(partial, 201, 0).estimated_cost_usd, 0.000402);
});

test("pagination limits and missing metadata cannot masquerade as complete collections", async () => {
  await assert.rejects(collectBenchGecko({ fetchImpl: async () => json({ meta: { pages: 51 }, data: [{ id: "vendor/model" }] }) }), /incomplete/);
  await assert.rejects(collectBenchGecko({ fetchImpl: async () => json({ data: Array.from({ length: 200 }, (_, i) => ({ id: `vendor/${i}` })) }) }), /incomplete/);
  let page = 0;
  await assert.rejects(collectCloudPrice({ fetchImpl: async () => json({ data: [{ id: "vendor/model" }], pagination: { has_next: true, next_token: String(++page) } }) }), /incomplete/);
  await assert.rejects(collectCloudPrice({ fetchImpl: async () => json({ data: [{ id: "vendor/model" }] }) }), /pagination/);
  await assert.rejects(collectArtificialAnalysis({ apiKey: "fixture-only", fetchImpl: async () => json({ data: [{ id: "vendor/model" }], has_more: true }) }), /incomplete/);
});

test("partial Portkey and Vals failures reject wholesale source replacement", async () => {
  await assert.rejects(collectPortkey({ providers: ["alpha", "beta"], fetchImpl: async (input) => String(input).includes("beta") ? new Response("unavailable", { status: 503 }) : json({ model: { pricing_config: { pay_as_you_go: { request_token: { price: 100 } } } } }) }), /incomplete/);
  await assert.rejects(collectVals({ fetchImpl: async (input) => {
    const url = String(input);
    if (url.endsWith("/benchmarks")) return new Response('<a href="/benchmarks/a">A</a><a href="/benchmarks/b">B</a>');
    if (url.endsWith("/b")) return new Response("unavailable", { status: 503 });
    return new Response(valsPage({ metadata: { slug: "a" }, tasks: { overall: { "vendor/model": { accuracy: 50 } } } }));
  } }), /incomplete/);
});

test("explicit context tiers override legacy price thresholds and negative rates stay unknown", () => {
  const pricing = normalizeMillionPricing({ input: 5, tiers: [{ tier: { type: "context", size: 272000, max: 1000000 }, input: 10 }], context_over_200k: { input: 10 } });
  const route = offer({ id: "route", providerId: "vendor", providerModelId: "model", pricing, evidence: [evidence] });
  const profile = { input_tokens: 250000, output_tokens: 0, cached_input_ratio: 0, requests_per_task: 1 };
  assert.equal(estimateWorkloadCost(route, profile).estimated_cost_usd, 1.25);
  assert.equal(estimateWorkloadCost(route, { ...profile, input_tokens: 272000 }).estimated_cost_usd, 2.72);
  assert.equal(pricing.find((point) => point.kind === "tiered")?.tier?.max, 1000000);
  for (const pricing of [normalizeMillionPricing({ input: -1 }), normalizeOpenRouterPricing({ prompt: -1 }), normalizePortkeyPricing({ pay_as_you_go: { request_token: { price: -1 } } })]) {
    assert.equal(pricing[0].amount_usd_per_unit, null);
    assert.equal(estimateWorkloadCost({ pricing }, profile).estimated_cost_usd, null);
  }
  assert.equal(estimateWorkloadCost({ pricing: [{ dimension: "input", unit: "token", kind: "fixed", amount_usd_per_unit: Number.MAX_VALUE }] }, profile).estimated_cost_usd, null);
});

test("OpenRouter context overrides use strict thresholds, last matching key and inherited rates", () => {
  const pricing = normalizeOpenRouterPricing({ prompt: "0.000001", completion: "0.000002", discount: 0.5,
    overrides: [{ min_prompt_tokens: 200000, prompt: "0.000003", completion: "0.000004" },
      { min_prompt_tokens: 100000, prompt: "0.000002" }] });
  const cost = (input: number) => estimateWorkloadCost({ pricing }, { input_tokens: input, output_tokens: 10, cached_input_ratio: 0, requests_per_task: 1 });
  assert.equal(cost(100000).estimated_cost_usd, 0.10002);
  assert.equal(cost(100001).estimated_cost_usd, 0.200022);
  assert.equal(cost(200000).estimated_cost_usd, 0.40002);
  assert.equal(cost(200001).estimated_cost_usd, 0.400042);
  assert.ok(pricing.every((point) => !["discount", "min_prompt_tokens"].includes(point.dimension)));
  assert.ok(pricing.every((point) => point.kind !== "scheduled"));
  assert.throws(() => normalizeOpenRouterPricing({ overrides: [{ min_completion_tokens: 100, prompt: "0.001" }] }), /unsupported.*override/);
  const timed = normalizeOpenRouterPricing({ prompt: "0.000001", overrides: [{ min_prompt_tokens: 100, utc_start: 1400, utc_end: 0, prompt: "0.000002" }] });
  const profile = { input_tokens: 100, output_tokens: 0, cached_input_ratio: 0, requests_per_task: 1 };
  assert.equal(estimateWorkloadCost({ pricing: timed }, profile).estimated_cost_usd, 0.0001);
  assert.equal(estimateWorkloadCost({ pricing: timed }, { ...profile, input_tokens: 101 }).estimated_cost_usd, null);
});

test("bounded overlapping tiers do not silently select a cheaper or more expensive rate", () => {
  const pricing = normalizeMillionPricing({ tiers: [
    { tier: { type: "context", min: 0, max: 200000 }, input: 1 },
    { tier: { type: "context", min: 100000, max: 300000 }, input: 5 },
  ] });
  const result = estimateWorkloadCost({ pricing }, { input_tokens: 150000, output_tokens: 0, cached_input_ratio: 0, requests_per_task: 1 });
  assert.equal(result.estimated_cost_usd, null);
  assert.ok(result.missing_dimensions.includes("input_tier"));
});

test("cache writes use explicit full-rate or surcharge billing and partition total prompt tokens", () => {
  const profile = { input_tokens: 10000, cached_input_ratio: 0.4, cache_write_tokens: 2000, output_tokens: 0, requests_per_task: 1 };
  const claude = normalizeOpenRouterPricing({ prompt: "0.000003", input_cache_read: "0.0000003", input_cache_write: "0.00000375" }, "anthropic/claude-sonnet-4.6");
  assert.equal(estimateWorkloadCost({ pricing: claude }, profile).estimated_cost_usd, 0.0207);
  const gemini = normalizeOpenRouterPricing({ prompt: "0.0000003", input_cache_read: "0.00000003", input_cache_write: "0.0000000833333333333333" }, "google/gemini-2.5-flash");
  assert.ok(Math.abs(estimateWorkloadCost({ pricing: gemini }, profile).estimated_cost_usd! - 0.002086666666666667) < 1e-12);
  const unknown = normalizeMillionPricing({ input: 3, cache_read: 0.3, cache_write: 3.75 });
  assert.ok(estimateWorkloadCost({ pricing: unknown }, profile).missing_dimensions.includes("cache_write_billing"));
  assert.throws(() => estimateWorkloadCost({ pricing: claude }, { ...profile, cache_write_tokens: 8000 }), /cannot exceed total/);
});

test("Arena retains Max product identities and only extracts documented effort suffixes", async () => {
  const result = await collectArena({ fetchImpl: async () => json({ rows: [
    { row: { model_name: "qwen2.5-max", organization: "Qwen", rating: 1000, category: "overall" } },
    { row: { model_name: "flux-1-kontext-max", organization: "BFL", rating: 1000, category: "overall" } },
  ] }) });
  assert.ok(result.records.some((record) => record.id === "qwen/qwen2.5-max"));
  assert.ok(result.records.some((record) => record.id === "bfl/flux-1-kontext-max"));
  assert.ok(result.records.every((record) => record.benchmarks?.every((row) => row.effort === undefined)));
  const efforts = await collectArena({ fetchImpl: async () => json({ rows: [
    { row: { model_name: "gemini-3.7-flash-high", organization: "Google", rating: 1000, category: "overall" } },
    { row: { model_name: "glm-5.3-max", organization: "Z.ai", rating: 1000, category: "overall" } },
    { row: { model_name: "kimi-k3-max", organization: "Moonshot", rating: 1000, category: "overall" } },
    { row: { model_name: "gpt-5.1-codex-max", organization: "OpenAI", rating: 1000, category: "overall" } },
    { row: { model_name: "gpt-5.1-codex-max-high", organization: "OpenAI", rating: 1000, category: "overall" } },
  ] }) });
  assert.ok(efforts.records.find((row) => row.id === "google/gemini-3.7-flash")?.benchmarks?.some((row) => row.effort === "high"));
  assert.ok(efforts.records.find((row) => row.id.endsWith("/glm-5.3"))?.benchmarks?.some((row) => row.effort === "max"));
  assert.ok(efforts.records.find((row) => row.id.endsWith("/kimi-k3"))?.benchmarks?.some((row) => row.effort === "max"));
  assert.deepEqual(new Set(efforts.records.find((row) => row.id === "openai/gpt-5.1-codex-max")?.benchmarks?.map((row) => row.effort)), new Set([undefined, "high"]));
});

test("Vals VoiceCodeBench preserves the semantics of TSR, CTEM and WER", async () => {
  const view = { metadata: { slug: "voice-code-bench", accuracy_label: "TSR (%)" }, tasks: {
    overall: { "vendor/model": { accuracy: 30 } }, ctem: { "vendor/model": { accuracy: 77 } }, wer: { "vendor/model": { accuracy: 5 } },
  } };
  const result = await collectVals({ fetchImpl: async (input) => new Response(String(input).endsWith("/benchmarks") ? '<a href="/benchmarks/voice-code-bench">Voice</a>' : valsPage(view)) });
  assert.deepEqual(result.records[0].benchmarks?.map((row) => [row.metric, row.unit]), [["task_success_rate", "percent"], ["canonical_token_entity_match", "percent"], ["wer", "percent"]]);
});

test("LiveBench task and category economics use their own question counts and raw keys", async () => {
  const payloads: Record<string, string> = {
    "constants.js": 'const releases = ["2026-06-25"];',
    "modelLinks.js": "export const modelLinks = {};",
    "table_2026_06_25.csv": "model,AMPS_Hard,javascript\ngpt-fixture,50,100\n",
    "categories_2026_06_25.json": JSON.stringify({ Math: ["AMPS_Hard"], Coding: ["javascript"] }),
    "cost_2026_06_25.csv": "model,AMPS_Hard,nq_AMPS_Hard,out_AMPS_Hard,javascript,nq_javascript,out_javascript,cost_per_question,avg_output_tokens\ngpt-fixture,1,100,20,9,10,200,0.090909,36.3636\n",
  };
  const result = await collectLiveBench({ fetchImpl: async (input) => new Response(payloads[String(input).split("/").at(-1)!]) });
  const rows = result.records[0].benchmarks!;
  assert.equal(rows.find((row) => row.benchmark_id === "livebench.amps_hard")?.metrics?.cost_per_question_usd, 0.01);
  assert.equal(rows.find((row) => row.benchmark_id === "livebench.amps_hard")?.metrics?.avg_output_tokens, 20);
  const coding = rows.find((row) => row.benchmark_id === "livebench.category.coding")!;
  assert.equal(coding.metrics?.cost_per_question_usd, 0.9);
  assert.equal(coding.metrics?.avg_output_tokens, 200);
  assert.equal(coding.sample_count, 10);
  assert.equal(rows.find((row) => row.benchmark_id === "livebench.overall")?.sample_count, 110);
});

test("Pipecat preserves provider IDs and compares models without model-specific lane keys", async () => {
  const modelNames = ["scribe_v2_realtime", "gemini-3.5-transcribe-live", "Nemotron 3.0 ASR (en)"];
  const readme = ["<!-- RESULTS_TABLE:START -->", "| Vendor | Model | Transcripts | Perfect | WER Mean | Pooled WER | TTFS Median | TTFS P95 | TTFS P99 |", "|---|---|---|---|---|---|---|---|---|", ...modelNames.map((model) => `| Vendor | ${model} | 99% | 80% | 2% | 2% | 100ms | 200ms | 300ms |`), "<!-- RESULTS_TABLE:END -->"].join("\n");
  const registry = modelNames.map((model, i) => `"service_${i}": ServiceDefinition(vendor="Vendor",model_label="${model}")`).join("\n");
  const result = await collectPipecatStt({ fetchImpl: async (input) => new Response(String(input).endsWith("services.py") ? registry : readme) });
  assert.deepEqual(result.records.flatMap((row) => row.offers ?? []).map((row) => row.provider_model_id).sort(), modelNames.slice(0, 2).sort());
  assert.equal(result.records.find((row) => row.name === modelNames[2])?.offers?.length, 0);
  assert.equal(new Set(result.records.map((row) => comparisonLaneId(row.benchmarks![0]))).size, 1);
  const truncated = readme.replace("| 100ms | 200ms | 300ms |", "| 100ms | 200ms |");
  assert.equal(parsePipecatResults(truncated).skippedRows, 1);
  await assert.rejects(collectPipecatStt({ fetchImpl: async (input) => new Response(String(input).endsWith("services.py") ? registry : truncated) }), /incomplete/);
});

test("bounded HTTP retries respect Retry-After and provenance redacts credential-shaped URL fields", async () => {
  let calls = 0;
  await assert.rejects(fetchJson("https://fixture.example", { fetchImpl: async () => { calls += 1; return new Response("retry", { status: 429, headers: { "retry-after": "60" } }); } }), /Retry-After/);
  assert.equal(calls, 1);
  await assert.rejects(mapWithConcurrency([1], 0, async (value) => value), /positive integer/);
  const redacted = redactUrl("https://fixture-user:fixture-password@example.test?API_KEY=fixture-key&accessToken=fixture-token");
  for (const value of ["fixture-user", "fixture-password", "fixture-key", "fixture-token"]) assert.ok(!redacted.includes(value));
});

function valsPage(view: unknown): string {
  const encode = (value: any): any => Array.isArray(value) ? [1, value.map(encode)] : value && typeof value === "object" ? [0, Object.fromEntries(Object.entries(value).map(([key, child]) => [key, encode(child)]))] : [0, value];
  const props = JSON.stringify({ benchmarkView: encode(view) }).replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  return `<astro-island component-url="/_astro/BenchmarkView.fixture.js" props="${props}"></astro-island>`;
}
