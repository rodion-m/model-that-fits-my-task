import type { Offer, SourceRecord, SourceResult } from "../types.js";
import { fetchJson } from "../http.js";
import { cacheWriteBilling, normalizeMillionPricing } from "../price.js";
import { baseRecord, mergeSourceRecord, newRecordMap, offer } from "./common.js";
import { capabilitiesFromParameters, evidence, reasoningSupport, record, stringValue } from "../source-utils.js";
import { arrayOfStrings, asRecord, boolValue, numberValue } from "../utils.js";

export const MODELS_DEV_URL = "https://models.dev/catalog.json";

export async function collectModelsDev(options: { fetchImpl?: typeof fetch } = {}): Promise<SourceResult> {
  const fetchedAt = new Date().toISOString();
  const payload = await fetchJson<any>(MODELS_DEV_URL, {
    fetchImpl: options.fetchImpl,
    timeoutMs: 30_000,
    maxBytes: 14 * 1024 * 1024,
    retries: 1,
  });
  const modelEntries = Object.entries(asRecord(payload?.models));
  const providerEntries = Object.entries(asRecord(payload?.providers));
  if (modelEntries.length === 0 && providerEntries.length === 0) throw new Error("Models.dev catalog returned no records");
  const records = new Map<string, SourceRecord>();
  for (const [key, value] of modelEntries) {
    const model = record(value);
    const id = stringValue(model.id) ?? key;
    const publisher = id.includes("/") ? id.split("/")[0] : undefined;
    const normalized = baseRecord({
      sourceId: "models_dev",
      rawId: id,
      publisher,
      name: model.name ?? key,
      family: model.family,
      releaseDate: model.release_date,
      openWeights: model.open_weights,
      license: model.license,
      contextTokens: model.limit?.context,
      maxOutputTokens: model.limit?.output,
      modalities: model.modalities,
      parameters: declaredParameters(model),
      reasoning: modelReasoning(model),
      fetchedAt,
      url: MODELS_DEV_URL,
      evidenceFields: ["metadata", "capabilities", "limits"],
    });
    normalized.capabilities = declaredCapabilities(model);
    normalized.evidence = [evidence("models_dev", MODELS_DEV_URL, fetchedAt, ["metadata", "capabilities", "limits", "reasoning_options"])];
    normalized.id = normalized.id || id;
    records.set(normalized.id, normalized);
  }
  const canonicalModels = new Map(records);
  for (const [providerKey, providerValue] of providerEntries) {
    const provider = record(providerValue);
    const providerName = stringValue(provider.name) ?? providerKey;
    for (const [modelKey, value] of Object.entries(asRecord(provider.models))) {
      const providerModel = record(value);
      const providerModelId = stringValue(providerModel.id) ?? modelKey;
      const modelId = findModelId(providerModel, modelKey, canonicalModels, providerKey);
      const existing = records.get(modelId);
      const sourceModel = existing ?? baseRecord({
        sourceId: "models_dev",
        rawId: `${providerKey}/${providerModelId}`,
        publisher: providerKey,
        name: providerModel.name ?? providerModelId,
        releaseDate: providerModel.release_date,
        openWeights: providerModel.open_weights,
        license: providerModel.license,
        contextTokens: providerModel.limit?.context,
        maxOutputTokens: providerModel.limit?.output,
        modalities: providerModel.modalities,
        parameters: declaredParameters(providerModel),
        reasoning: modelReasoning(providerModel),
        fetchedAt,
        url: MODELS_DEV_URL,
        evidenceFields: ["provider", "pricing", "capabilities"],
      });
      sourceModel.id = modelId;
      const params = declaredParameters(providerModel);
      const capabilities = declaredCapabilities(providerModel);
      const reasoning = modelReasoning(providerModel);
      const reasoningEntry = reasoning !== undefined
        ? reasoningSupport("models_dev", typeof reasoning === "boolean" ? { supported: reasoning } : reasoning, fetchedAt, MODELS_DEV_URL, params)
        : undefined;
      const providerOffer: Offer = offer({
        id: `models_dev:${providerKey}:${providerModelId}`,
        providerId: providerKey,
        providerName,
        providerModelId,
        status: providerModel.status === "deprecated" ? "absent" : "active",
        contextTokens: providerModel.limit?.context,
        maxOutputTokens: providerModel.limit?.output,
        supportedParameters: params,
        capabilities,
        reasoningEfforts: reasoningEntry?.efforts,
        dataPolicy: providerModel.data_policy,
        pricing: normalizeMillionPricing(providerModel.cost, cacheWriteBilling(modelId, "models_dev")),
        evidence: [evidence("models_dev", MODELS_DEV_URL, fetchedAt, ["provider", "pricing", "capabilities", "limits"])],
      });
      const extra: Partial<SourceRecord> = {
        capabilities,
        offers: [providerOffer],
        ...(reasoningEntry ? { reasoning: [reasoningEntry] } : {}),
        evidence: [evidence("models_dev", MODELS_DEV_URL, fetchedAt, ["provider", "pricing", "capabilities"])],
      };
      records.set(modelId, mergeSourceRecord(sourceModel, extra));
    }
  }
  return {
    source_id: "models_dev",
    url: MODELS_DEV_URL,
    fetched_at: fetchedAt,
    status: "ok",
    records: [...newRecordMap([...records.values()]).values()],
  };
}

function declaredParameters(model: Record<string, any>): string[] {
  return [...new Set([
    ...arrayOfStrings(model.supported_parameters ?? model.parameters),
    ...(model.tool_call === true ? ["tools"] : []),
    ...(model.structured_output === true ? ["structured_outputs"] : []),
  ])];
}

function declaredCapabilities(model: Record<string, any>): Record<string, boolean | null> {
  const declared = capabilitiesFromParameters(declaredParameters(model));
  return {
    ...declared,
    tools: boolValue(model.tool_call) ?? declared.tools,
    structured_outputs: boolValue(model.structured_output) ?? declared.structured_outputs,
    reasoning: boolValue(model.reasoning) ?? null,
  };
}

function modelReasoning(model: Record<string, any>): Record<string, unknown> | undefined {
  const options = model.reasoning_options;
  if (options === undefined && model.reasoning === undefined) return undefined;
  if (!Array.isArray(options)) return { ...asRecord(options ?? model.reasoning), ...(typeof model.reasoning === "boolean" ? { supported: model.reasoning } : {}) };
  const controls = options.map(record);
  return {
    supported: boolValue(model.reasoning) ?? (controls.length > 0 ? true : null),
    efforts: controls.filter((control) => control.type === "effort").flatMap((control) => arrayOfStrings(control.values)),
    controls: controls.flatMap((control) => stringValue(control.type) ? [String(control.type)] : []),
  };
}

function findModelId(providerModel: Record<string, any>, modelKey: string, records: Map<string, SourceRecord>, providerKey: string): string {
  const candidates = [`${providerKey}/${providerModel.id ?? modelKey}`, providerModel.id, modelKey].filter(Boolean).map(String);
  for (const candidate of candidates) {
    if (records.has(candidate)) return candidate;
  }
  const suffixMatches = [...records.keys()].filter((id) => candidates.some((candidate) => id.endsWith(`/${candidate}`)));
  if (suffixMatches.length === 1) return suffixMatches[0];
  return `${providerKey}/${modelKey}`.toLowerCase();
}
