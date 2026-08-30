import type { BenchmarkDefinition, Offer, SourceRecord, SourceResult } from "../types.js";
import { fetchJson, fetchText, mapWithConcurrency } from "../http.js";
import { canonicalModelId } from "../identity.js";
import { normalizeMillionPricing, normalizePortkeyPricing } from "../price.js";
import { baseRecord, mergeSourceRecord, newRecordMap, offer } from "./common.js";
import { evidence, numeric, record, reasoningSupport, runtimeFromMetrics, stringValue } from "../source-utils.js";
import { asArray, asRecord, arrayOfStrings, boolValue, numberValue } from "../utils.js";

export const MODELCAP_URL = "https://modelcap.ai/data/models.json";
export const BENCHGECKO_URL = "https://benchgecko.ai/api/v1/models";
export const CLOUDPRICE_URL = "https://ai.cloudprice.net/api/v1/models";
export const EPOCH_URL = "https://epoch.ai/data/notable_ai_models.csv";

export async function collectModelCap(options: { fetchImpl?: typeof fetch } = {}): Promise<SourceResult> {
  const fetchedAt = new Date().toISOString();
  const payload = await fetchJson<any>(MODELCAP_URL, { fetchImpl: options.fetchImpl, timeoutMs: 30_000, maxBytes: 12 * 1024 * 1024 });
  const rows = asArray(payload?.models);
  if (rows.length === 0) throw new Error("ModelCap returned no models");
  const records = rows.map((row) => {
    const item = record(row);
    const normalized = baseRecord({
      sourceId: "modelcap",
      rawId: item.modelId ?? item.slug ?? item.name,
      publisher: item.publisher,
      name: item.name,
      releaseDate: item.releasedAt,
      openWeights: item.weightAccess === "open" ? true : item.weightAccess === "closed" ? false : undefined,
      contextTokens: item.contextTokens,
      fetchedAt,
      url: MODELCAP_URL,
      evidenceFields: ["metadata", "ranking", "pricing", "provider_coverage"],
    });
    normalized.benchmarks = numeric(item.modelCap) !== undefined ? [{ benchmark_id: "modelcap.model_cap", value: numeric(item.modelCap)!, evidence: evidence("modelcap", MODELCAP_URL, fetchedAt, ["ranking"], [], "Secondary ranking signal.") }] : [];
    const prices = normalizeMillionPricing(item.pricingUsdPerMillionTokens);
    normalized.pricing_observations = prices.length > 0 ? [{ pricing: prices, evidence: evidence("modelcap", MODELCAP_URL, fetchedAt, ["pricing"], [], "OpenRouter-observed snapshot pricing.") }] : [];
    normalized.offers = asArray(item.currentProviderEndpoints).flatMap((endpoint) => normalizeProviderEndpoint(endpoint, fetchedAt));
    normalized.evidence = [evidence("modelcap", MODELCAP_URL, fetchedAt, ["metadata", "ranking", "pricing", "provider_coverage"])];
    return normalized;
  });
  return { source_id: "modelcap", url: MODELCAP_URL, fetched_at: fetchedAt, status: "ok", records: [...newRecordMap(records).values()] };
}

export async function collectBenchGecko(options: { fetchImpl?: typeof fetch } = {}): Promise<SourceResult> {
  const fetchedAt = new Date().toISOString();
  const pages: Array<{ url: string; payload: any }> = [];
  let expectedPages: number | undefined;
  let complete = false;
  let page = 1;
  for (; page <= 50; page += 1) {
    const url = new URL(BENCHGECKO_URL);
    url.searchParams.set("page", String(page));
    url.searchParams.set("limit", "200");
    const payload = await fetchJson<any>(url.toString(), { fetchImpl: options.fetchImpl, timeoutMs: 30_000, maxBytes: 12 * 1024 * 1024 });
    pages.push({ url: url.toString(), payload });
    if (payload?.meta?.pages !== undefined) {
      if (!Number.isSafeInteger(payload.meta.pages) || payload.meta.pages < 1) throw new Error("BenchGecko returned invalid page count");
      expectedPages = payload.meta.pages;
    }
    const rows = asArray(payload?.data ?? payload?.models ?? payload);
    if (expectedPages !== undefined ? page >= expectedPages : rows.length < 200) { complete = true; break; }
  }
  if (!complete) throw new Error("BenchGecko pagination exceeded 50 pages; collection is incomplete");
  const rows = pages.flatMap(({ payload }) => asArray(payload?.data ?? payload?.models ?? payload));
  if (rows.length === 0) throw new Error("BenchGecko returned no models");
  const records = pages.flatMap(({ url, payload }) => asArray(payload?.data ?? payload?.models ?? payload).map((row) => {
    const item = record(row);
    const normalized = baseRecord({
      sourceId: "benchgecko",
      rawId: item.slug ?? item.id ?? item.name,
      publisher: item.provider,
      name: item.name,
      releaseDate: item.release_date,
      openWeights: item.is_open_source,
      contextTokens: item.context_window,
      fetchedAt,
      url,
      evidenceFields: ["metadata", "benchmarks", "pricing"],
    });
    const scores = Object.entries(asRecord(item.scores)).flatMap(([key, value]) => numeric(value) === undefined ? [] : [{ benchmark_id: `benchgecko.${key}`, value: numeric(value)!, evidence: evidence("benchgecko", url, fetchedAt, ["benchmarks"], [], "Secondary aggregator; consult source methodology.") }]);
    if (numeric(item.avg_score) !== undefined) scores.push({ benchmark_id: "benchgecko.avg_score", value: numeric(item.avg_score)!, evidence: evidence("benchgecko", url, fetchedAt, ["benchmarks"], [], "Secondary aggregator; consult source methodology.") });
    normalized.benchmarks = scores;
    const pricing = normalizeMillionPricing({ input: item.pricing?.input, output: item.pricing?.output, cache_read: item.pricing?.cache_read });
    normalized.pricing_observations = pricing.length > 0 ? [{ pricing, evidence: evidence("benchgecko", url, fetchedAt, ["pricing"], ["openrouter"], "Pricing is reported by a secondary aggregator.") }] : [];
    normalized.evidence = [evidence("benchgecko", url, fetchedAt, ["metadata", "benchmarks", "pricing"])]
    return normalized;
  }));
  const warnings = expectedPages !== undefined && pages.length < expectedPages ? [`pagination stopped at ${pages.length}/${expectedPages} pages`] : [];
  return { source_id: "benchgecko", url: BENCHGECKO_URL, fetched_at: fetchedAt, status: "ok", records: [...newRecordMap(records).values()], warnings };
}

export async function collectCloudPrice(options: { fetchImpl?: typeof fetch } = {}): Promise<SourceResult> {
  const fetchedAt = new Date().toISOString();
  const pages: Array<{ url: string; payload: any }> = [];
  const seenTokens = new Set<string>();
  let nextToken: string | undefined;
  let hasNext = true;
  for (let page = 0; page < 50 && hasNext; page += 1) {
    const url = new URL(CLOUDPRICE_URL);
    url.searchParams.set("page_size", "200");
    if (nextToken) url.searchParams.set("next_token", nextToken);
    const pageUrl = url.toString();
    const payload = await fetchJson<any>(pageUrl, { fetchImpl: options.fetchImpl, timeoutMs: 30_000, maxBytes: 16 * 1024 * 1024 });
    pages.push({ url: pageUrl, payload });
    if (typeof payload?.pagination?.has_next !== "boolean") throw new Error("CloudPrice response omitted pagination.has_next");
    hasNext = payload.pagination.has_next;
    const returnedToken = stringValue(payload?.pagination?.next_token);
    if (hasNext && (!returnedToken || seenTokens.has(returnedToken))) throw new Error("CloudPrice pagination returned a repeated or empty next_token");
    if (returnedToken) seenTokens.add(returnedToken);
    nextToken = returnedToken;
  }
  if (hasNext) throw new Error("CloudPrice pagination exceeded 50 pages; collection is incomplete");
  const rows = pages.flatMap(({ payload }) => asArray(payload?.data ?? payload?.models ?? payload));
  if (rows.length === 0) throw new Error("CloudPrice returned no models");
  const records = pages.flatMap(({ url, payload }) => asArray(payload?.data ?? payload?.models ?? payload).map((row) => {
    const item = record(row);
    const normalized = baseRecord({
      sourceId: "cloudprice",
      rawId: item.id ?? item.slug ?? item.name,
      publisher: item.provider ?? item.creator,
      name: item.display_name ?? item.name ?? item.model,
      family: item.family,
      releaseDate: item.release_date,
      openWeights: item.is_open_source,
      license: item.license,
      knowledgeCutoff: item.knowledge_cutoff ?? item.training_data_cutoff,
      contextTokens: item.context_window ?? item.contextWindow,
      maxOutputTokens: item.max_output_tokens,
      modalities: item.modalities,
      parameters: Object.entries(asRecord(item.capabilities)).filter(([, value]) => value === true).map(([key]) => key),
      fetchedAt,
      url,
      evidenceFields: ["metadata", "pricing", "aliases"],
    });
    normalized.aliases = [
      ...(normalized.aliases ?? []),
      ...arrayOfStrings(item.ids).map((id) => ({ id, source_id: "cloudprice", kind: "source_id" })),
    ];
    normalized.capabilities = {
      ...(normalized.capabilities ?? {}),
      tools: boolValue(item.capabilities?.function_calling) ?? normalized.capabilities?.tools ?? null,
      structured_outputs: boolValue(item.capabilities?.structured_outputs) ?? normalized.capabilities?.structured_outputs ?? null,
      vision: boolValue(item.capabilities?.vision) ?? null,
      audio: boolValue(item.capabilities?.audio) ?? null,
      reasoning: boolValue(item.capabilities?.reasoning) ?? null,
    };
    if (item.supported_reasoning_efforts !== undefined) {
      normalized.reasoning = [reasoningSupport("cloudprice", { supported: true, supported_efforts: item.supported_reasoning_efforts }, fetchedAt, url)];
    }
    const pricing = normalizeMillionPricing(item.pricing ?? { input: item.input_price, output: item.output_price, cache_read: item.cache_read_price });
    normalized.pricing_observations = pricing.length > 0 ? [{ pricing, evidence: evidence("cloudprice", url, fetchedAt, ["pricing"], ["artificial-analysis"], "CloudPrice benchmark/pricing feed may be derived; retain provenance.") }] : [];
    normalized.evidence = [evidence("cloudprice", url, fetchedAt, ["metadata", "pricing", "aliases"])];
    return normalized;
  }));
  const warnings = hasNext ? ["pagination capped at 50 pages"] : [];
  return { source_id: "cloudprice", url: CLOUDPRICE_URL, fetched_at: fetchedAt, status: "ok", records: [...newRecordMap(records).values()], warnings };
}

export async function collectPortkey(options: { fetchImpl?: typeof fetch; providers?: string[] } = {}): Promise<SourceResult> {
  const fetchedAt = new Date().toISOString();
  const providers = options.providers ?? (process.env.PORTKEY_PROVIDERS ?? "anthropic,openai,google,bedrock,vertex-ai,deepseek,mistral-ai,together-ai,groq,openrouter").split(",").map((value) => value.trim()).filter(Boolean);
  const results = await mapWithConcurrency(providers, 5, async (provider) => {
    const url = `https://configs.portkey.ai/pricing/${encodeURIComponent(provider)}.json`;
    try {
      return { provider, url, payload: await fetchJson<any>(url, { fetchImpl: options.fetchImpl, timeoutMs: 20_000, maxBytes: 8 * 1024 * 1024, retries: 0 }) };
    } catch (error) {
      return { provider, url, payload: undefined, error: error instanceof Error ? error.message : String(error) };
    }
  });
  const records: SourceRecord[] = [];
  const warnings: string[] = [];
  const failures = results.filter((result) => result.error);
  if (failures.length > 0) throw new Error(`Portkey collection is incomplete: ${failures.map((result) => `${result.provider}: ${result.error}`).join("; ")}`);
  for (const result of results) {
    if (!result.payload) {
      warnings.push(`${result.provider}: ${result.error}`);
      continue;
    }
    for (const [modelKey, value] of Object.entries(asRecord(result.payload))) {
      const item = record(value);
      const normalized = baseRecord({ sourceId: "portkey", rawId: `${result.provider}/${modelKey}`, publisher: result.provider, name: item.name ?? modelKey, fetchedAt, url: result.url, evidenceFields: ["pricing"] });
      const prices = normalizePortkeyPricing(item);
      if (prices.length === 0) continue;
      normalized.offers = [offer({ id: `portkey:${result.provider}:${modelKey}`, providerId: result.provider, providerName: result.provider, providerModelId: modelKey, status: "unknown", pricing: prices, evidence: [evidence("portkey", result.url, fetchedAt, ["pricing"], [], "Pricing-only supplement; availability is unknown.")] })];
      normalized.evidence = [evidence("portkey", result.url, fetchedAt, ["pricing"])];
      records.push(normalized);
    }
  }
  if (records.length === 0) throw new Error("Portkey returned no pricing records");
  return { source_id: "portkey", url: "https://configs.portkey.ai/pricing/", fetched_at: fetchedAt, status: "ok", records: [...newRecordMap(records).values()], warnings };
}

export async function collectEpoch(options: { fetchImpl?: typeof fetch } = {}): Promise<SourceResult> {
  const fetchedAt = new Date().toISOString();
  const text = await fetchText(EPOCH_URL, { fetchImpl: options.fetchImpl, timeoutMs: 30_000, maxBytes: 8 * 1024 * 1024 });
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error("Epoch CSV returned no rows");
  const records = rows.flatMap((row) => {
    const name = firstColumn(row, ["model version", "model", "name"]);
    if (!name) return [];
    const creator = firstColumn(row, ["organization", "company", "creator", "developer"]);
    const normalized = baseRecord({ sourceId: "epoch", rawId: `epoch:${name}`, name, publisher: undefined, releaseDate: firstColumn(row, ["release date", "date"]), fetchedAt, url: EPOCH_URL, evidenceFields: ["metadata", "compute"] });
    normalized.aliases?.push({ id: name, source_id: "epoch", kind: "display_name" });
    if (creator) normalized.creators = [creator];
    normalized.evidence = [evidence("epoch", EPOCH_URL, fetchedAt, ["metadata", "compute"], [], "Unresolved display-name record; no fuzzy identity merge.")];
    return [normalized];
  });
  return { source_id: "epoch", url: EPOCH_URL, fetched_at: fetchedAt, status: "ok", records: [...newRecordMap(records).values()] };
}

function normalizeProviderEndpoint(value: unknown, fetchedAt: string): Offer[] {
  const item = record(value);
  const provider = stringValue(item.provider ?? item.provider_name);
  const modelId = stringValue(item.modelId ?? item.model_id);
  if (!provider || !modelId) return [];
  return [offer({ id: `modelcap:${provider}:${modelId}`, providerId: provider, providerName: provider, providerModelId: modelId, quantization: item.quantization, contextTokens: item.contextTokens ?? item.context_length, pricing: normalizeMillionPricing(item.pricing), runtime: item.performance ? [runtimeFromMetrics("modelcap", MODELCAP_URL, fetchedAt, item.performance)] : [], evidence: [evidence("modelcap", MODELCAP_URL, fetchedAt, ["provider_coverage"]) ] })];
}

function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i += 1; } else quoted = !quoted;
    } else if (char === "," && !quoted) { row.push(cell); cell = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell); cell = "";
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
    } else cell += char;
  }
  if (cell || row.length > 0) { row.push(cell); rows.push(row); }
  const headers = (rows.shift() ?? []).map((value) => value.trim().toLowerCase());
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() ?? ""])));
}

function firstColumn(row: Record<string, string>, names: string[]): string | undefined {
  for (const name of names) {
    const key = Object.keys(row).find((value) => value === name || value.includes(name));
    if (key && row[key]) return row[key];
  }
  return undefined;
}
