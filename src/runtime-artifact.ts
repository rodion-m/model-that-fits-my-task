import { comparisonLaneId } from "./lane.js";
import type { Model, RuntimeQueryArtifact, Snapshot } from "./types.js";

export function buildRuntimeQueryArtifact(snapshot: Snapshot): RuntimeQueryArtifact {
  return {
    artifact_kind: "runtime_query",
    schema_version: snapshot.schema_version,
    generated_at: snapshot.generated_at,
    content_hash: snapshot.content_hash,
    workload_profiles: snapshot.workload_profiles,
    sources: snapshot.sources,
    benchmarks: snapshot.benchmarks,
    models: snapshot.models.map(compactModel),
    observations: snapshot.models.flatMap((model) => model.benchmarks.map((observation) => ({
      ...observation,
      model_id: model.id,
      lane_id: comparisonLaneId(observation),
    }))),
  };
}

export function snapshotFromRuntimeArtifact(artifact: RuntimeQueryArtifact): Snapshot {
  if (!Array.isArray(artifact.models) || !Array.isArray(artifact.observations)) throw new Error("runtime artifact collections are invalid");
  const modelIds = new Set(artifact.models.map((model) => model?.id));
  if (artifact.models.some((model) => !model?.id) || modelIds.size !== artifact.models.length) throw new Error("runtime artifact model IDs must be unique and present");
  const observationsByModel = new Map<string, RuntimeQueryArtifact["observations"]>();
  for (const observation of artifact.observations) {
    if (!observation || !modelIds.has(observation.model_id)) throw new Error("runtime artifact observation references an unknown model");
    if (observation.lane_id !== comparisonLaneId(observation)) throw new Error("runtime artifact comparison lane mismatch");
    const current = observationsByModel.get(observation.model_id) ?? [];
    current.push(observation);
    observationsByModel.set(observation.model_id, current);
  }
  return {
    schema_version: artifact.schema_version,
    generated_at: artifact.generated_at,
    content_hash: artifact.content_hash,
    workload_profiles: artifact.workload_profiles,
    sources: artifact.sources,
    benchmarks: artifact.benchmarks,
    models: artifact.models.map((model) => {
      const observations = observationsByModel.get(model.id) ?? [];
      return {
        ...model,
        benchmarks: observations.map(({ model_id: _modelId, lane_id: _laneId, ...observation }) => observation),
      };
    }),
  };
}

export function isRuntimeQueryArtifact(value: unknown): value is RuntimeQueryArtifact {
  return Boolean(value && typeof value === "object" && (value as RuntimeQueryArtifact).artifact_kind === "runtime_query");
}

function compactModel(model: Model): RuntimeQueryArtifact["models"][number] {
  const { benchmarks: _benchmarks, ...rest } = model;
  return rest;
}
