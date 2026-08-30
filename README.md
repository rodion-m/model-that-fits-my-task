# model-that-fits-my-task

An agent skill for choosing AI models and provider routes for your task,
backed by the **Models Labyrinth** API service. The service keeps its existing
name and URL: https://models-labyrinth.vercel.app/api/v1.

The repository includes a source-aware catalog and model-selection atlas covering models, provider
routes, prices, reasoning efforts, benchmark scores, and published runtime
metrics. GitHub Actions schedules refreshes twice a day; publication requires
the licensing review below. API reads make no network requests.

## Model-selection skill

The repository includes [`model-that-fits-my-task`](.agents/skills/model-that-fits-my-task/SKILL.md),
an agent skill that turns a workload description into an evidence-backed model
and provider-route recommendation. It uses the filtered API for ordinary
decisions and downloads the full snapshot together with its JSON Schema only
when the comparison cannot be expressed efficiently through API filters.

The skill keeps model quality, provider behavior, quantization, price, and
evidence confidence separate until the user's task makes their trade-offs
explicit. Its normal mode is `competitive`; `frontier` is reserved for an
explicit maximum-quality request. API `available` scope is only a deployability
inventory, and `all` is almost exclusively for historical or audit work. It
does not run models or invent a universal leaderboard score.
When a ranked answer is useful, its offline selector can calculate a
task-relative score from exact comparison lanes and user-visible weights. The
result always exposes observed percentile quality, benchmark coverage,
confidence, cohort size, and per-lane contributions. Confidence is a disclosed
heuristic, not a statistical confidence interval or a probability of success.
Scores depend on the filtered cohort and are not comparable between cohorts.
For explicit quality-versus-price decisions, the selector also computes a
strict Pareto front for a named or custom workload. It maximizes task-fit,
minimizes complete estimated cost, applies an optional quality floor first, and
keeps unknown-cost choices outside the front instead of treating them as free.
Unknown or incompatible workload limits and unverified quality transfer
between effort/quantization configurations also remain outside the front.
The `quality-cost-speed` mode adds median TTFT and output TPS as independent
objectives—TTFT is minimized and TPS maximized—without hiding them behind one
speed score. Route-scoped speed is the default; explicit model scope remains an
approximation and never becomes provider evidence.
Routes with identical known objective values are grouped as equivalent offers
instead of filling the result page with duplicate Pareto points.
Every selected route also carries a workload-shaped operational validation
plan—10 sequential representative requests plus 2 concurrent requests by
default—with explicit 429/`Retry-After` checks. Agentic recommendations must
separate cache support/pricing from route-scoped cache hit rate and propose a
stable-prefix real run when the rate is unknown. The skill never executes these
credit-spending requests without separate authorization.
Its business-domain playbook routes finance, legal, healthcare, education,
public-service, office, SaaS automation, customer-service, HR, IT operations,
cybersecurity, and modernization workloads to the closest available evidence,
while naming domains where the current snapshot has only weak proxy coverage.
For endpoint-level routing after an OpenRouter model slug is chosen, it links
to the maintained
[`openrouter-provider-ranking`](https://github.com/CodeAlive-AI/ai-driven-development/tree/main/skills/openrouter-provider-ranking)
skill instead of duplicating that specialized workflow.

## Architecture

```text
upstream APIs/feeds
        -> adapters with provenance and bounded fetches
        -> deterministic merge and validation
        -> models_db.json
        -> module-scope snapshot + query index
        -> Vercel /api/v1/* or static GitHub Pages projection
```

`models_db.json` remains the only complete portable snapshot. Deployments
parse a build-time `runtime-query.json` artifact once per Function
instance, cache the snapshot and query index for the life of that instance, and
invalidate on a new deployment. The archival JSON is not reparsed on an hourly
timer. Successful responses use CDN cache headers with a one-hour TTL;
errors use `no-store`, and internal error details are not returned. The
full snapshot stays downloadable as `/api/v1/snapshot.json`.

The runtime currently materializes a snapshot and builds an in-memory query
index. The reproducible benchmark below measures this implementation; it does
not establish superiority over SQLite, NDJSON, or streaming JSON. The runtime
artifact flattens observations and is not necessarily smaller than a minified
archive. Monitor both cold-start memory and file sizes before deploying.

## Sources

Each observation stores its `source_id`, URL, fetch time, covered fields, and
`derived_from` when a value is republished or aggregated by another source.
Conflicts are not collapsed into an invented single rating.

- [OpenRouter models](https://openrouter.ai/docs/guides/overview/models) and
  [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)
  — model catalog, prices, cache, capabilities, quantization, and rolling
  provider runtime metrics.
- [Models.dev](https://models.dev) — model/provider metadata, limits,
  modalities, tools, structured output, reasoning, and pricing.
- [BenchLM data](https://www.benchlm.ai/data) — benchmarks, pricing, and speed;
  AA-derived rows retain their provenance.
- [Artificial Analysis Data API](https://artificialanalysis.ai/data-api/docs)
  — headline indices, median performance, and pricing when `AA_API_KEY` is
  available. The key is never stored in git or the snapshot. Public
  redistribution requires an applicable license; see the publication gate.
- [Artificial Analysis Speech to Text](https://artificialanalysis.ai/speech-to-text/non-streaming)
  — the free API adds the overall AA-WER index for STT models. Provider-level
  price/speed and per-dataset WER remain tier-gated; the adapter keeps that
  limitation explicit instead of fabricating routes.
- [Pipecat STT Benchmark](https://github.com/pipecat-ai/stt-benchmark) —
  provider/model streaming results with semantic WER, transcript success,
  perfect-transcript rate, and TTFS median/P95/P99. The current published set
  is English-only and is consumed from its upstream README table. The adapter
  also preserves the repository's service-registry keys as aliases. Only a
  registry-backed, machine-like provider model ID becomes a route; descriptive
  labels remain unresolved benchmark evidence.
- [Hugging Face Open ASR Leaderboard](https://github.com/huggingface/open_asr_leaderboard)
  — published short-form and long-form WER/RTFx CSVs, including explicit
  per-language multilingual lanes. The current multilingual CSV publishes
  German, French, Italian, Spanish, and Portuguese results; absent language
  values remain absent rather than being inferred.
- [Vals benchmarks](https://www.vals.ai/benchmarks) — public evaluation
  snapshots for finance, legal, healthcare, education, coding, agentic, and
  academic tasks, including run-level effort, harness, provider, latency,
  token, and workload-spend fields when published. Vals has no documented
  public leaderboard read API, so the refresh reads the structured Astro page
  payloads and fails visibly if their contract changes.
- [LiveBench](https://livebench.ai) — official release-aware objective
  subtasks across reasoning, coding, agentic coding, mathematics, data
  analysis, language, and instruction following, plus published evaluation
  cost/token metadata. The adapter reads release tables from the
  [official repository](https://github.com/LiveBench/new-livebench); category
  and overall values are retained as derived aggregates, while subtasks remain
  independent benchmark observations.
- [Arena](https://arena.ai/leaderboard) — latest model-level blind pairwise
  human-preference ratings from the official
  [LMSYS leaderboard dataset](https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset).
  Text, factuality, vision, search, document, web-development, image, and
  video configurations are fetched from the Hugging Face rows API. Agent
  configurations are excluded because they measure a model plus an agent
  harness. Ratings retain votes, confidence bounds, variance, rank, publish
  date, and configuration; they are not treated as objective task accuracy.
- [ForecastBench](https://forecastbench.org/leaderboards/) — current official
  baseline leaderboard for model-only probabilistic forecasting. Dataset,
  market, and overall Brier Index observations retain confidence intervals,
  sample counts, model variants, and effort suffixes. Tool-enabled tournament
  rows and pseudo-baselines are excluded from the model feed.
- [ParseBench](https://github.com/run-llama/ParseBench) and
  [ExtractBench](https://github.com/run-llama/ExtractBench) — official raw
  leaderboard CSVs for document processing. ParseBench covers tables, charts,
  content faithfulness, semantic formatting, and visual grounding; ExtractBench
  covers schema-guided value F1 by document length plus precision/recall,
  grounding, latency, and evaluation cost. ParseBench costs are normalized from
  cents/page to USD/page; ExtractBench costs are already USD/page. Rows without
  an exact model identifier remain benchmark-only unresolved records and never
  become provider offers.
- [Epoch AI](https://epoch.ai/benchmarks/use-this-data) — independent
  benchmark and model-compute context with conservative identity joins.
- [Portkey models](https://github.com/Portkey-AI/models) — pricing supplement
  for batch/cache/audio/image/search/thinking-token dimensions.
- BenchGecko, ModelCap, and CloudPrice — secondary cross-check observations;
  overlaps with AA/OpenRouter are not treated as independent benchmark
  sources.

The database contains only data from network sources. The project does not run
model evaluations, probes, or its own provider error/latency/cache-hit measurements.
Therefore, `measurements[]` is populated only when an upstream source actually
publishes the corresponding facts.

### Benchmark admission policy

The primary model-quality layer admits a feed only when it has a current
published result, a stable machine-readable source suitable for the twice-daily
refresh, an identifiable model-level evaluation scope, explicit metric and
version/condition metadata, and source provenance. Human-preference ratings
(Arena) and objective task scores (for example LiveBench or ForecastBench)
remain separate comparison families; the API never blends them into one
universal leaderboard.

Current code-review, agent, and harness benchmarks are not automatically added
just because their methodology is interesting. CR-Bench, c-CRAB, CodeReviewBench,
PRBench, and similar evaluations measure a model together with context,
tooling, an agent loop, or a judge. They are valuable for a separate system-level
layer, but their current public score feeds are either not model-only or are not
stable/machine-readable enough for this repository's automated refresh. They
remain documented watchlist candidates until that boundary is explicit.

## API

All collection endpoints return an envelope with `data` and `meta`:

```json
{
  "data": [],
  "meta": {
    "total": 0,
    "limit": 50,
    "offset": 0,
    "has_more": false,
    "updated_at": "...",
    "schema_version": "1.0",
    "scope": "available",
    "excluded_count": 0
  }
}
```

- `GET /api/v1/models?q=gpt&provider=openrouter&capability=tools&limit=50`
- `GET /api/v1/models?view=summary&capability=tools&capability=structured_outputs&sort=released&limit=100`
- `GET /api/v1/models?scope=all&released_after=2024-01-01`
- `GET /api/v1/models/:id`
- `GET /api/v1/offers?model=openai/gpt-5&provider=openrouter&capability=tools&has_runtime=true&profile=rag-long-prefix&sort=cost`
- `GET /api/v1/offers?capability=structured_outputs&profile=custom&input_tokens=10000&output_tokens=300&cached_input_ratio=0.5&cache_write_tokens=4000&reasoning_tokens=200&sort=cost`
- `GET /api/v1/facets` — discover available capability, effort, quantization, modality, and source values.
- `GET /api/v1/providers`
- `GET /api/v1/benchmarks?kind=benchmark&q=terminal` — canonical benchmark catalog; `kind` accepts `benchmark`, `index`, `aggregate`, or `claim`, while `q` also matches upstream aliases.
- `GET /api/v1/benchmark-observations?benchmark=coding.terminalBench21&effort=high` — canonical paginated observations with a `lane_id`. Defaults to `scope=available`. `sort=score` requires one comparison lane and a known or explicitly supplied score direction.
- `GET /api/v1/profiles`
- `GET /api/v1/health`
- `GET /api/v1/schema` — JSON Schema for the complete `models_db.json`.
- `GET /api/v1/snapshot` — redirect to the full static `snapshot.json`.

`/models`, `/offers`, `/facets`, and `/benchmark-observations` default to
`scope=available`: canonical models with at least one active, unexpired offer
whose availability evidence is no older than 36 hours at `generated_at`.
Pricing-only sources cannot establish availability or freshen an old catalog
observation; their offers have `status: "unknown"`. A catalog's explicit
`absent` status takes precedence over a pricing supplement. Release age is not
an availability signal. `scope=all` returns the complete historical and
unresolved catalog. Responses include `meta.scope` and `meta.excluded_count`.
`sort=updated`
orders by evidence freshness; `sort=released` orders by `release_date`.
Unknown enum values, malformed booleans/numbers/dates, unsupported sort keys,
and incompatible argument combinations return HTTP 400 with `error.parameter`.

Model filters cover id/name/alias, provider, capability, reasoning effort,
modality, quantization, source, benchmark, open weights, minimum context,
supported parameters, runtime/cache presence, release-date bounds, and sorting.
When provider, capability, effort, quantization, context, runtime, cache, or
supported-parameter constraints are supplied together, one offer must satisfy
all of them. Summaries and facets describe offers eligible for the requested
scope; they do not use an excluded route to prove capabilities or context.
Use `view=summary` for broad candidate discovery; fetch full
records only for the shortlist. Summary pages are capped at 100 rows;
full-record pages are capped at 10 to stay safely below serverless response
limits. Repeated or comma-separated capabilities are ANDed. Repeated
providers, efforts, quantizations, and sources are ORed. Provider values are
exact provider ids; use `/providers` to discover them.

Offer filters additionally cover supported parameters, minimum route context,
exact model ids, modalities, presence of runtime observations, presence of declared cache pricing, price
estimate, and workload profile. `sort=cost` requires a profile; `sort=context`
does not. Use `profile=custom` with required `input_tokens` and `output_tokens`
when the named profiles do not match the task; `cached_input_ratio` defaults to
zero and `requests_per_task` to one. Optional `cache_write_tokens` and
`reasoning_tokens` are supported on any profile. `estimated_cost_usd` is a
deterministic calculation from unambiguous input, output, cache-read,
cache-write, request, reasoning, and applicable context-tier prices. If a
required dimension or tier cannot be resolved, the total is `null` and
`missing_dimensions` names exactly what is missing. The estimate is not
measured cost or a latency prediction.

`input_tokens` is the total prompt per request, including cache reads and
writes. Read tokens are `input_tokens × cached_input_ratio`; read + write must
not exceed total input. Ordinary input is the remaining part. A cache write
may replace the ordinary input charge (`cache_write_billing: "full_rate"`, as
for Claude) or add a storage surcharge to it (`"surcharge"`, as for Gemini on
OpenRouter). Missing billing semantics remain unknown. Named profiles are
illustrative assumptions, not measured cache hit rates.

Each costed offer includes `workload_compatibility`. Budget filters admit only
known compatible workloads; `sort=cost` puts compatible routes before unknown
or incompatible routes. Time-based and unsupported volume pricing remain
unknown. OpenRouter context overrides use strict `min_prompt_tokens` thresholds
and last-match-wins rules per price dimension; returned prices already include
any advertised discount.

Benchmark observations keep comparison conditions attached. A comparison lane
is the canonical benchmark plus evidence source, metric, unit, variant,
effort, evaluator, dataset version, and configuration. Sorting by score is a
client error unless the result set is a single comparison lane. WER and Brier
score are lower-is-better; Brier Index is higher-is-better. An unspecified
metric such as `score` requires `direction=higher` or `direction=lower` unless
the observation declares its direction. Conflicting directions are rejected.

The August 2026 review added source identity to lane hashing. Previously saved
lane IDs must be rediscovered; do not reuse them across this migration. The
offline scorer rejects claim/aggregate rows and preserves missing scores,
sample counts, uncertainty, and per-lane evidence instead of treating gaps as
measured zeroes.

Vercel Functions have a 4.5 MB response-body limit, so collection pages are
limited to 100 items. For complete offline analysis, use the static
`/api/v1/snapshot.json` and `/api/v1/schema.json` on GitHub Pages or Vercel.
`vercel.json` checks types and publication rights before building, and includes `runtime-query.json`
in the dynamic API function bundle. The full snapshot is served as a static
file, not through a Function. When `SNAPSHOT_DOWNLOAD_URL` is set, the snapshot
redirect can point directly to a GitHub/GitHub Pages URL. Health and the
downloaded snapshot share one `content_hash` and generation. Readers recompute
SHA-256 over schema version, workload profiles, benchmark definitions and
models; timestamps and source statuses are checked separately. A matching
declared hash alone is insufficient.

Local Vercel uploads exclude generated `public/` and `runtime-query.json`;
the deployment build recreates both from the tracked archive. Do not upload
duplicate generated copies against the platform's source-upload size budget.

## Local development

Use Node 24.x. Deterministic checks do not load `.env` or contact providers.

```bash
npm install
npm run update:db       # network refresh; AA uses .env when configured
npm run typecheck
npm run check           # typecheck, rebuild generated files, deterministic tests
npm test                # rebuild generated files, deterministic tests
npm run test:live       # opt-in public API smoke tests
npm run build:static    # public/api/v1/* for GitHub Pages
npm run benchmark       # local query timings; no model/API calls
npm run check:publication # explicit redistribution preflight
```

Copy `.env.example` to `.env`. Never commit real keys:

```dotenv
AA_API_KEY=
OPENROUTER_API_KEY=
OPENROUTER_ENDPOINTS=1
OPENROUTER_ENDPOINT_CAP=120
OPENROUTER_ENDPOINT_CONCURRENCY=6
```

`update:db` and `test:live` explicitly load `.env` when present. To refresh only
public sources without loading that file or using inherited keys:

```bash
env -u AA_API_KEY -u OPENROUTER_API_KEY node --import tsx scripts/update-db.ts
```

If a source is unavailable, its status becomes `error` or `skipped` and its
previous projection is preserved, including its last successful record count.
Empty, truncated, malformed, and accidentally partial complete collections
fail visibly. A partial refresh retains statuses of sources not attempted.
If all sources fail, the file is not replaced. Status-only changes are persisted.
Each successful source is validated before merging, then the complete snapshot
is validated and written using a unique temporary file, fsync and atomic rename.

`metadata_by_source` and multi-source offers' `source_projections` let refresh
remove withdrawn fields from just their owner. Legacy mixed metadata without
field ownership is discarded conservatively on replacement, not assigned to a
surviving source. Benchmark aliases do not confer ownership of a definition.
OpenRouter endpoint refreshes rotate by last attempt, including empty/error
results. An endpoint response resolving to a different model release is rejected;
listing dates and tokenizer names are not model release dates or families.

Speech observations are intentionally not interchangeable with text-model
quality scores. STT WER is lower-is-better and carries its dataset/language
lane; Pipecat TTFS is a streaming end-of-speech latency measure, while Open ASR
RTFx is a local benchmark throughput measure. None of these fields imply
provider availability or a live route unless an offer is separately present.

## GitHub Actions and deployment

`.github/workflows/refresh.yml` runs at `03:17` and `15:17` UTC and can also be
started manually. Add `AA_API_KEY` and, if needed, `OPENROUTER_API_KEY` as
repository or environment secrets if their use is authorized. The workflow
checks types, refreshes data, rebuilds and tests the projection, checks
publication rights, then commits a changed `models_db.json` and publishes
GitHub Pages. `.github/workflows/check.yml` runs deterministic checks for every
push and pull request with read-only repository permissions.

### Publication gate

This repository and its static endpoints can be public. Artificial Analysis
distinguishes internal API access from redistribution rights in its
[Data API terms](https://artificialanalysis.ai/data-api). The repository does
not establish which license its operator holds. `check:publication` examines
retained evidence, derived-source markers, and evaluator provenance, including
AA STT and data retained after a skipped refresh. Removing the API key does not
remove those data.

Only after an applicable redistribution license is confirmed should an operator
set `AA_REDISTRIBUTION_LICENSE_CONFIRMED=1` in the deployment environment and
the matching GitHub Actions repository variable. Without confirmation, the
automated workflow stops before push/Pages and Vercel stops before publishing;
local checks and `build:static` remain available. This gate is not access
control: it does not protect existing Git history, already-public artifacts,
manual pushes, or prebuilt deployments. Do not bypass it merely to make CI green.

ParseBench and ExtractBench are ordinary registered adapters, so both CSVs are
refetched on every scheduled run without any additional secret or workflow
step.

On Vercel, a new snapshot enters the runtime only after a new deployment. The
in-process cache lasts for the instance lifetime; a new deployment is the
invalidation. Immutable deployment files are not reparsed on a timer.

The static projection contains:

- `index.html` — the lightweight landing page;
- `labyrinth-hero.jpg` — the landing-page hero asset;
- `api/v1/snapshot.json` — complete snapshot;
- `api/v1/schema.json` — schema;
- `api/v1/models.json` and `api/v1/models/index.json` — compact model index;
- `api/v1/models/<base64url-id>.json` — individual model records;
- `api/v1/offers.json` — first page of the current-scope flat offer representation;
- `api/v1/benchmark-observations.json` — first page of current-scope observations;
- `api/v1/providers.json`, `benchmarks.json`, `profiles.json`, `facets.json`, `health.json`.
The deploy also writes `runtime-query.json` at the repository root for the
Vercel Function bundle. It is derived from the snapshot, shares `content_hash`,
and is not a second archival source of truth.

Use `models_db.json` for the complete offer list. Static `offers.json` is
intentionally limited to the same page size as the dynamic API so it does not
duplicate the large snapshot.

GitHub Pages cannot perform arbitrary server-side filtering; clients can
download the snapshot and schema and filter locally. Vercel provides the same
query layer dynamically.

## Reproducible query benchmark

```bash
npm run build:static
npm run benchmark -- --iterations 100 --warmup 5 --output /tmp/model-query-benchmark.json
```

The harness uses a fresh Node process per artifact and records snapshot hash,
generation, Node/tsx/platform versions, pretty/minified archive and runtime
sizes, load plus validation time, index construction, first query, warm p50/p95,
serialization time, response size, and RSS. Cases cover model summaries, costed
offers, facets and a single score lane. It makes no network requests. OS page
cache is uncontrolled: these are process-cold, not disk-cold measurements.

Results describe the local catalog implementation, not model quality,
provider latency, serverless cold starts, or CDN performance. No flaky timing
threshold is imposed in CI. Historical SQLite/streaming comparisons without a
reproducible harness were removed. See the [review report](docs/review-2026-08-31.md)
and [recorded measurements](docs/review-2026-08-31-benchmark.json).
