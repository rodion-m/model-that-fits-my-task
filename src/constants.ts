import type { WorkloadProfile } from "./types.js";

export const SCHEMA_VERSION = "1.0" as const;
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;
export const DEFAULT_MAX_BYTES = 12 * 1024 * 1024;
export const CACHE_TTL_SECONDS = 60 * 60;
export const SNAPSHOT_CACHE_TTL_MS = Number.POSITIVE_INFINITY;
export { EVIDENCE_STALE_MS } from "../.agents/skills/model-that-fits-my-task/scripts/catalog-scope.mjs";
export const RUNTIME_QUERY_FILENAME = "runtime-query.json";

export const WORKLOAD_PROFILES: WorkloadProfile[] = [
  {
    id: "chat-short",
    description: "Short interactive request without a reusable prefix.",
    input_tokens: 1_000,
    cached_input_ratio: 0,
    output_tokens: 300,
    requests_per_task: 1,
  },
  {
    id: "rag-long-prefix",
    description: "Illustrative 25k-token retrieval request: 20k cache-read tokens, 5k new cache-write tokens, and 1k output tokens.",
    input_tokens: 25_000,
    cached_input_ratio: 0.8,
    cache_write_tokens: 5_000,
    output_tokens: 1_000,
    requests_per_task: 1,
  },
  {
    id: "agentic-multistep",
    description: "Illustrative seven-step workflow averaging 25k input per request: 17.5k cache-read and 7.5k new cache-write tokens.",
    input_tokens: 25_000,
    cached_input_ratio: 0.7,
    cache_write_tokens: 7_500,
    output_tokens: 1_000,
    requests_per_task: 7,
  },
  {
    id: "batch-long-output",
    description: "Batch-style request with a long generated answer.",
    input_tokens: 4_000,
    cached_input_ratio: 0,
    output_tokens: 8_000,
    requests_per_task: 1,
  },
];
