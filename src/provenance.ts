import { mergeCapabilities } from "./source-utils.js";
import type { Model, ModelMetadata, SourceRecord } from "./types.js";

const METADATA_FIELDS = [
  "identity_confidence", "name", "creators", "family", "release_date", "knowledge_cutoff",
  "open_weights", "license", "modalities", "context_tokens", "max_output_tokens", "capabilities",
] as const;
const CONFIDENCE_RANK = { unresolved: 0, alias: 1, exact: 2 } as const;

export function metadataOf(record: SourceRecord): ModelMetadata {
  return Object.fromEntries(METADATA_FIELDS.filter((key) => record[key] !== undefined)
    .map((key) => [key, structuredClone(record[key])])) as ModelMetadata;
}

export function metadataProjections(model: Model): Record<string, ModelMetadata> {
  if (model.metadata_by_source) return { ...model.metadata_by_source };
  const sources = [...new Set(model.evidence.map((item) => item.source_id))];
  // Legacy multi-source scalars have no reliable attribution. Do not transfer a
  // removed source's claims to a surviving source during migration.
  return sources.length === 1 ? { [sources[0]]: metadataOf(model) } : {};
}

export function mergeMetadata(left: ModelMetadata, right: ModelMetadata): ModelMetadata {
  const confidence = [left.identity_confidence, right.identity_confidence]
    .filter((value): value is Model["identity_confidence"] => value !== undefined)
    .sort((a, b) => CONFIDENCE_RANK[b] - CONFIDENCE_RANK[a])[0];
  return {
    ...left,
    ...right,
    ...(confidence ? { identity_confidence: confidence } : {}),
    creators: [...new Set([...(left.creators ?? []), ...(right.creators ?? [])])].sort(),
    modalities: {
      input: [...new Set([...(left.modalities?.input ?? []), ...(right.modalities?.input ?? [])])].sort(),
      output: [...new Set([...(left.modalities?.output ?? []), ...(right.modalities?.output ?? [])])].sort(),
    },
    capabilities: mergeCapabilities(left.capabilities, right.capabilities),
    open_weights: typeof right.open_weights === "boolean" ? right.open_weights : left.open_weights ?? null,
  };
}

export function applyMetadata(model: Model, projections: Record<string, ModelMetadata>): Model {
  const retained = { ...model };
  for (const key of METADATA_FIELDS) delete (retained as Partial<Model>)[key];
  // Catalog names and release metadata take precedence over benchmark labels.
  const priority = (source: string): number => source === "openrouter" ? 2 : source === "models_dev" ? 1 : 0;
  const ordered = Object.entries(projections).sort(([a], [b]) => priority(a) - priority(b) || a.localeCompare(b));
  let metadata: ModelMetadata = {
    name: model.id, identity_confidence: "unresolved", creators: [], open_weights: null,
    modalities: { input: [], output: [] }, capabilities: {},
  };
  for (const [, projection] of ordered) metadata = mergeMetadata(metadata, projection);
  const openWeights = new Set(ordered.map(([, value]) => value.open_weights).filter((value) => typeof value === "boolean"));
  if (openWeights.size > 1) metadata.open_weights = null;
  return { ...retained, ...metadata, metadata_by_source: Object.fromEntries(ordered) } as Model;
}
