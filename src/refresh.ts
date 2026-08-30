import type { Snapshot, SourceResult } from "./types.js";
import { SOURCE_ADAPTERS, type SourceAdapter } from "./sources/index.js";
import { mergeSnapshots, validateSnapshot } from "./merge.js";
import { readSnapshot, writeSnapshotAtomic } from "./storage.js";
import { contentHash } from "./hash.js";

export async function collectSources(
  previous: Snapshot | undefined,
  adapters: SourceAdapter[] = SOURCE_ADAPTERS,
  fetchImpl?: typeof fetch,
): Promise<SourceResult[]> {
  return Promise.all(adapters.map(async (adapter) => {
    try {
      const result = await adapter.collect({ previous, fetchImpl });
      const previousCount = previous?.sources.find((source) => source.source_id === adapter.source_id)?.record_count ?? 0;
      if (result.status === "ok" && result.replace_previous !== false
        && previousCount > 0 && result.records.length < previousCount * 0.5) {
        return {
          ...result,
          status: "error" as const,
          records: [],
          replace_previous: false,
          error: `source record count dropped from ${previousCount} to ${result.records.length}; previous projection was kept`,
        };
      }
      if (result.status === "ok" && result.replace_previous !== false && result.records.length === 0) {
        return { ...result, status: "error" as const, replace_previous: false, error: "source returned an empty catalog; previous projection was kept" };
      }
      if (result.source_id !== adapter.source_id) throw new Error("adapter returned a different source identity");
      // Validate one normalized projection before it can replace retained data.
      // A malformed source must not abort updates from every healthy source.
      if (result.status === "ok") mergeSnapshots(undefined, [result], result.fetched_at);
      return result.status === "ok" && result.replace_previous === undefined
        ? { ...result, replace_previous: true }
        : result;
    } catch (error) {
      return {
        source_id: adapter.source_id,
        url: adapter.url,
        fetched_at: new Date().toISOString(),
        status: "error" as const,
        records: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));
}

export async function refreshDatabase(options: {
  path: string;
  adapters?: SourceAdapter[];
  fetchImpl?: typeof fetch;
  now?: string;
  minModelRatio?: number;
}): Promise<{ snapshot: Snapshot; results: SourceResult[]; changed: boolean }> {
  const previous = await readSnapshot(options.path);
  const results = await collectSources(previous, options.adapters, options.fetchImpl);
  const successful = results.filter((result) => result.status === "ok" && result.records.length > 0);
  if (successful.length === 0) throw new Error("all configured sources failed or were skipped; previous snapshot was kept");
  const snapshot = mergeSnapshots(previous, results, options.now ?? new Date().toISOString());
  const ratio = options.minModelRatio ?? 0.5;
  if (snapshot.models.length === 0) throw new Error("refresh produced an empty model snapshot");
  if (previous && snapshot.models.length < previous.models.length * ratio) throw new Error("refresh produced an unexpectedly small snapshot");
  validateSnapshot(snapshot);
  const changed = !previous || previous.content_hash !== snapshot.content_hash
    || previous.generated_at !== snapshot.generated_at || contentHash(previous.sources) !== contentHash(snapshot.sources);
  if (changed) await writeSnapshotAtomic(options.path, snapshot);
  return { snapshot, results, changed };
}
