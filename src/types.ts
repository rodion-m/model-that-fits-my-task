export type SourceStatusKind = "ok" | "error" | "skipped";
export type EvidenceStatus = "observed" | "derived" | "stale";
export type BenchmarkKind = "benchmark" | "index" | "aggregate" | "claim";
export type PriceUnit =
  | "token"
  | "million_tokens"
  | "request"
  | "image"
  | "search"
  | "second"
  | "character"
  | "unknown";
export type PriceKind = "fixed" | "variable" | "tiered" | "scheduled";

export interface Evidence {
  source_id: string;
  url: string;
  fetched_at: string;
  status: EvidenceStatus;
  fields?: string[];
  derived_from?: string[];
  note?: string;
}

export interface PricePoint {
  dimension: string;
  unit: PriceUnit;
  amount_usd_per_unit: number | null;
  raw: string | number | null;
  kind: PriceKind;
  tier?: {
    type: "context" | "volume";
    min?: number;
    max?: number;
  };
  schedule?: {
    utc_days?: string[];
    utc_start?: number;
    utc_end?: number;
  };
  /** Original order for conditional upstream overrides (later entries win per price key). */
  override_index?: number;
  /** Whether a cache write rate includes ordinary input billing or is an extra charge. */
  cache_write_billing?: "full_rate" | "surcharge";
}

export interface BenchmarkObservation {
  benchmark_id: string;
  source_benchmark_ids?: string[];
  kind?: BenchmarkKind;
  value: number;
  metric?: string;
  unit?: string;
  variant?: string;
  effort?: string;
  evaluator?: string;
  dataset_version?: string;
  sample_count?: number;
  metrics?: Record<string, number | string | boolean | null>;
  configuration?: Record<string, number | string | boolean | null>;
  evidence: Evidence;
}

export interface BenchmarkDefinition {
  id: string;
  aliases?: string[];
  kind?: BenchmarkKind;
  name?: string;
  category?: string;
  description?: string;
  year?: number;
  version?: string;
  updated_at?: string;
  dataset_type?: string;
  url?: string;
  evidence: Evidence;
}

export interface RuntimeObservation {
  scope: "model" | "offer";
  window?: string;
  latency_seconds?: Record<string, number>;
  ttft_seconds?: Record<string, number>;
  throughput_tokens_per_second?: Record<string, number>;
  uptime_fraction?: Record<string, number>;
  metrics?: Record<string, number | string | null>;
  evidence: Evidence;
}

export interface MeasurementObservation {
  kind: "measurement";
  offer_id: string;
  workload_profile_id?: string;
  reasoning_config?: Record<string, unknown>;
  status: "pass" | "fail" | "partial" | "unknown";
  metrics: Record<string, number | string | boolean | null>;
  sample_count?: number;
  evidence: Evidence;
}

export interface ReasoningSupport {
  source_id: string;
  supported: boolean | null;
  mandatory?: boolean;
  efforts?: string[];
  controls?: string[];
  evidence: Evidence;
}

export interface Offer {
  id: string;
  provider_id: string;
  provider_name?: string;
  provider_model_id: string;
  variant?: string;
  status: "active" | "absent" | "unknown";
  expires_at?: string;
  quantization?: string;
  context_tokens?: number;
  max_output_tokens?: number;
  supported_parameters: string[];
  capabilities: Record<string, boolean | null>;
  reasoning_efforts: string[];
  data_policy?: Record<string, unknown>;
  pricing: PricePoint[];
  runtime: RuntimeObservation[];
  measurements: MeasurementObservation[];
  evidence: Evidence[];
  /** Retained only for offers reported by multiple sources, so replacement can remove one contribution. */
  source_projections?: Record<string, Omit<Offer, "source_projections">>;
}

export interface Model {
  id: string;
  identity_confidence: "exact" | "alias" | "unresolved";
  name: string;
  creators: string[];
  family?: string;
  aliases: Array<{ id: string; source_id: string; kind?: string }>;
  release_date?: string;
  knowledge_cutoff?: string;
  open_weights: boolean | null;
  license?: string;
  modalities: { input: string[]; output: string[] };
  context_tokens?: number;
  max_output_tokens?: number;
  capabilities: Record<string, boolean | null>;
  reasoning: ReasoningSupport[];
  offers: Offer[];
  benchmarks: BenchmarkObservation[];
  pricing_observations: Array<{
    pricing: PricePoint[];
    evidence: Evidence;
  }>;
  runtime_observations: RuntimeObservation[];
  measurements: MeasurementObservation[];
  evidence: Evidence[];
  /** Source-specific scalar metadata; flattened fields are recomputed after each source replacement. */
  metadata_by_source?: Record<string, ModelMetadata>;
}

export type ModelMetadata = Partial<Pick<Model,
  "identity_confidence" | "name" | "creators" | "family" | "release_date" | "knowledge_cutoff"
  | "open_weights" | "license" | "modalities" | "context_tokens" | "max_output_tokens" | "capabilities"
>>;

export interface SourceRecord {
  id: string;
  identity_confidence?: Model["identity_confidence"];
  name?: string;
  creators?: string[];
  family?: string;
  aliases?: Model["aliases"];
  release_date?: string;
  knowledge_cutoff?: string;
  open_weights?: boolean | null;
  license?: string;
  modalities?: Model["modalities"];
  context_tokens?: number;
  max_output_tokens?: number;
  capabilities?: Record<string, boolean | null>;
  reasoning?: ReasoningSupport[];
  offers?: Offer[];
  benchmarks?: BenchmarkObservation[];
  pricing_observations?: Model["pricing_observations"];
  runtime_observations?: RuntimeObservation[];
  measurements?: MeasurementObservation[];
  evidence?: Evidence[];
}

export interface SourceResult {
  source_id: string;
  url: string;
  fetched_at: string;
  status: SourceStatusKind;
  records: SourceRecord[];
  benchmark_definitions?: BenchmarkDefinition[];
  warnings?: string[];
  replace_previous?: boolean;
  error?: string;
}

export interface SourceStatus {
  source_id: string;
  url: string;
  status: SourceStatusKind;
  attempted_at: string;
  last_success_at?: string;
  record_count: number;
  warning_count: number;
  error?: string;
}

export interface Snapshot {
  schema_version: "1.0";
  generated_at: string;
  content_hash: string;
  workload_profiles: WorkloadProfile[];
  sources: SourceStatus[];
  benchmarks: BenchmarkDefinition[];
  models: Model[];
}

export interface WorkloadProfile {
  id: string;
  description: string;
  input_tokens: number;
  cached_input_ratio: number;
  output_tokens: number;
  requests_per_task: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
}

export interface ApiEnvelope<T> {
  data: T[];
  meta: {
    total: number;
    limit: number;
    offset: number;
    has_more: boolean;
    updated_at: string;
    schema_version: string;
    scope?: "available" | "all";
    excluded_count?: number;
    score_direction?: "higher" | "lower";
  };
}

export interface RuntimeQueryArtifact {
  artifact_kind: "runtime_query";
  schema_version: Snapshot["schema_version"];
  generated_at: string;
  content_hash: string;
  workload_profiles: WorkloadProfile[];
  sources: SourceStatus[];
  benchmarks: BenchmarkDefinition[];
  models: Array<Omit<Model, "benchmarks">>;
  observations: Array<BenchmarkObservation & { model_id: string; lane_id: string }>;
}

export interface FetchOptions {
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  retries?: number;
}
