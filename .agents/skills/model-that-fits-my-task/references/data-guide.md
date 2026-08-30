# Models Labyrinth data guide

Read this reference when a recommendation needs detailed field interpretation or an offline snapshot query.

## Contents

- [Choose the correct unit](#choose-the-correct-unit)
- [Choose the catalog scope](#choose-the-catalog-scope)
- [API-first queries](#api-first-queries)
- [Comparison lanes](#comparison-lanes)
- [Field interpretation](#field-interpretation)
- [Provenance and confidence](#provenance-and-confidence)
- [Offline snapshot analysis](#offline-snapshot-analysis)
- [Recommendation quality](#recommendation-quality)

## Choose the correct unit

The database has three useful levels:

- `model`: identity, general capabilities, modalities, context, model-level benchmarks and observations;
- `offer`: a provider route for a model, including provider model id, status, quantization, supported parameters, prices, runtime claims, data policy, and reasoning efforts;
- `measurement`: a published observation tied to an offer and optionally a workload profile and reasoning configuration.

The strongest production recommendation names an offer. When only model-level quality evidence exists, say that provider behavior remains a separate uncertainty.

## Choose the catalog scope

Selection endpoints default to `scope=available`: canonical identities with at
least one active, unexpired offer backed by availability evidence no older than 36 hours at
snapshot generation time. Release age is deliberately irrelevant. This scope
answers “what appears deployable?”, not “what should I choose?”.
Fresh price data cannot establish or refresh availability; pricing-only offers
have `status: "unknown"` and do not overturn a catalog's explicit `absent` state.

Using `available` as the final shortlist is rare; first apply the task's quality
gate. Use `scope=all` almost exclusively for explicit historical, exhaustive,
supersession, reproducibility, or audit work. It includes stale, unavailable,
unresolved, and offerless records. Preserve `meta.scope` and exclusion counts.

## API-first queries

Start with health and facet discovery:

```text
GET /health
GET /providers?scope=available
GET /benchmarks?kind=benchmark
GET /profiles
```

Form candidates with conjunctive filters:

```text
GET /models?scope=available&capability=tools&min_context=100000&provider=openrouter&sort=released&limit=100
GET /offers?scope=available&provider=openrouter&capability=tools&capability=structured_outputs&min_context=100000&limit=100
GET /benchmark-observations?scope=available&benchmark=agentic.toolathlonVerified&limit=100
GET /offers?scope=available&model=openai/gpt-5&provider=openrouter&profile=custom&input_tokens=10000&output_tokens=300&cached_input_ratio=0.5&cache_write_tokens=5000&reasoning_tokens=1000&sort=cost&limit=100
```

Capabilities, modalities, and supported parameters in one request are ANDed.
Offer-scoped constraints must be true on one offer; support from one provider
cannot satisfy a query for another provider. Repeated models, providers,
reasoning efforts, quantizations, and sources are alternatives (OR). Follow
`meta.has_more` using `offset`; summary, offer, and observation pages cap at 100
records, while complete model pages cap at 10. Invalid values return HTTP 400
instead of silently broadening the query.

`sort=released` means model release recency. `sort=updated` means newest source
evidence and must not be described as model recency.

Fetch a full model record with its URL-encoded canonical id:

```text
GET /models/openai%2Fgpt-5
```

Static GitHub Pages exposes a compact model index and base64url-named individual files, but no arbitrary server-side filtering. Prefer the Vercel API for queries and the static mirror for complete downloads.

## Comparison lanes

A comparison lane is the exact tuple of canonical benchmark, evidence source, metric, unit,
variant, effort, evaluator, dataset version, and configuration. The API exposes
that tuple through `lane_id`. Sort by score only after selecting one lane; a
mixed-lane score sort is a client error. WER and Brier score sort ascending;
Brier Index sorts descending. For an unspecified metric such as `score`, supply
`direction=higher|lower` or use the observation's declared direction. Conflicting
directions are errors. Rediscover lane IDs saved before the August 2026 addition
of source identity to lane hashing.

Two observations with the same benchmark ID are not automatically comparable.
Never average or median different lanes, and never move a score between model
versions, batch routes, quantizations, tool modes, or reasoning efforts. Keep
independent sources in separate lanes even when an evaluator or version is
missing. Lane equality establishes matching recorded conditions, not proof
that every undocumented evaluation detail is identical.

## Field interpretation

| Need | Inspect | Important caveat |
| --- | --- | --- |
| General quality | `benchmarks[]` | Match canonical benchmark, metric, variant, effort, evaluator, version, and unit. Exclude aggregate/claim rows. |
| Structured output | `capabilities`, offer `supported_parameters`, relevant benchmarks/measurements | A support flag is not an adherence percentage. |
| Tool use | `capabilities`, offer `supported_parameters`, tool-use benchmarks | Declared support and measured reliability are different claims. |
| Reasoning | `reasoning[]`, offer `reasoning_efforts` | Availability does not imply the same token budget or behavior across providers. |
| Speed | offer `runtime[]`, then model `runtime_observations[]` | Preserve scope, percentile, window, and source. Median-only data hides tails. |
| Context | model and offer `context_tokens`, `max_output_tokens` | The route may be more restrictive than the model. |
| Cost | offer `pricing[]`, workload estimate details | Normalize units and include cache read/write, output, reasoning, request, and applicable tier dimensions. Unknown required dimensions make the complete estimate unknown. |
| Cache economics | `cache_read`, `cache_write`, profile estimate | Published cache prices are not a workload cache-hit rate. |
| Quantization | offer `quantization` | Quality impact is unknown unless the same quantized route was evaluated. |
| Privacy/routing | offer `data_policy`, provider identity | Missing policy data is unknown, not privacy-safe. |
| Open deployment | `open_weights`, `license` | Open weights and permissive commercial licensing are separate questions. |
| Freshness | root `generated_at`, `sources[]`, each `evidence` | A fresh snapshot can preserve older evidence from a failed source. |

For agentic recommendations, inspect any route-scoped cache measurement in
`measurements[]` and its evidence. Most sources publish only cache support and
prices, so the correct catalog result is often `unknown`. Never synthesize a hit
rate from `cached_input_ratio`: that field is a workload assumption used for
cost estimation. Use the operational-validation reference named in `SKILL.md`
to propose a real repeated-prefix measurement after selection.

Input tokens include the complete prompt: cache reads plus cache writes plus
ordinary input. `read = input_tokens × cached_input_ratio` and `read + write`
must not exceed total input. The estimator distinguishes cache-write full
replacement rates (Claude) from storage surcharges added to input billing
(Gemini on OpenRouter); undocumented billing semantics remain unknown. Named
workloads are illustrative, not observations. Applicable context prices follow
their explicit bounds; unknown scheduled/volume prices do not become zero.
API budget filters require `workload_compatibility.status: "compatible"`.

Vals business benchmarks add observed task accuracy, run configuration, and
where published, task-level latency, token counts, and spend. Treat
`cost_per_test` and `api_cost_usd` as the cost of that evaluation workload, not
as provider list pricing. Likewise, `provider`, `harness`, and effort fields
describe the evaluated setup rather than a currently available provider offer.

LiveBench adds release-versioned objective subtasks across reasoning, coding,
agentic coding, mathematics, data analysis, language, and instruction following.
Its `effort`, `evaluator`, `dataset_version`, and evaluation conditions must remain in
the comparison lane; retain source model IDs as provenance, not lane keys that
would separate every model into a cohort of one. Category and overall observations are explicit derived
aggregates; do not count them as extra task votes. Its evaluation cost, average
token, and published input/output price fields describe the benchmark run, not
a current provider route quote.

ParseBench and ExtractBench are document-processing benchmark feeds, not
provider catalogs. ParseBench observations use `variant` for tables, charts,
content faithfulness, semantic formatting, and visual grounding; its published
cost columns are normalized to `metrics.evaluation_cost_usd_per_page` from
cents/page. ExtractBench uses `variant` for short, medium, and long documents
and keeps precision, recall, word/page grounding, per-document latency, and
USD/page evaluation cost in `metrics`. A row with no exact model identifier is
an unresolved evaluation-system record with no offer; do not recommend it as a
deployable route or infer provider availability from its score.

Speech-to-text evidence needs an explicit language and operating mode. WER is
lower-is-better and must not be compared across different datasets, languages,
normalizers, or streaming/batch conditions. Pipecat's published STT benchmark
is an English-only streaming comparison of provider/model routes: its semantic
WER and transcript rates are quality signals, while TTFS percentiles describe
time from end-of-speech to final transcription; TTFS is not TTFT. Open ASR
publishes model-level English short-form/long-form tracks and a multilingual
track with separate current CSV lanes for German, French, Italian, Spanish, and
Portuguese; its RTFx is benchmark runtime, not provider API throughput.
Hardware must be taken from each row; do not assign H200 to rows with no
published hardware. The Artificial Analysis free STT endpoint currently exposes an
overall AA-WER index only; do not infer a provider route, price, speed, or
language score from it. For multilingual work, prefer the exact target-language
lane, disclose a coverage gap when it is absent, and never treat an aggregate
average as evidence for every language.

## Provenance and confidence

Every important observation should carry `evidence.source_id`, `url`, `fetched_at`, and `status`. `observed` means the adapter read it from that source. `derived` means the source or catalog republished or transformed another source; inspect `derived_from`. `stale` means retained older data.

Inspect timestamps even when evidence is not explicitly labeled stale. Source
replacement recomputes scalar metadata from `metadata_by_source` and shared
offers from `source_projections`; a discarded source's claims must not be
reattributed to another source. An OpenRouter catalog listing timestamp is not
the model's release date.

`identity_confidence` describes the join, not model quality:

- `exact`: strong identifier match;
- `alias`: matched through a known alias;
- `unresolved`: keep separate unless the user accepts the ambiguity.

`benchmark_id` is the canonical identity. `source_benchmark_ids` retains the
upstream field names that were merged into it; use these to audit provider,
harness, metric, and legacy aliases. `kind` distinguishes a primary
`benchmark`, named composite `index`, source-calculated `aggregate`, and opaque
provider `claim`. Do not count BenchLM, CloudPrice, or BenchGecko republishing
the same upstream score as three independent confirmations. The `/benchmarks`
inventory exposes aliases, source coverage, and an `independent_sources` view.

## Offline snapshot analysis

Download both files so field interpretation stays coupled to the data version:

```bash
node scripts/download-snapshot.mjs --out /tmp/models-labyrinth
```

The script fetches health first and revalidates cached bytes before reuse.
It checks nested schema shape, recomputes SHA-256, and matches generation,
counts and source statuses against health. Status-only changes require a new
generation even if the content hash is unchanged. It fails
visibly; it does not combine Vercel health with a different GitHub Pages
snapshot or hide a broken source behind a fallback.

The returned `snapshot_path` and `schema_path` point into an immutable
`generations/<uuid>/` directory. An atomic `bundle.json` manifest identifies the
current generation. Read the returned paths, not a legacy `<cache>/snapshot.json`.
Concurrent downloads cannot mix files. Corrupt-cache recovery is reported by
`cache_status` and `cache_validation_error`. Old generations are retained so
in-flight readers stay safe; remove unused generations explicitly when no
analysis is using them.

For a complex but bounded selection, use the selector instead of writing ad hoc
one-off parsers:

```bash
node scripts/select-models.mjs \
  --cache /tmp/models-labyrinth \
  --scope available \
  --provider openrouter \
  --effort high \
  --quantization fp8 \
  --capability tools \
  --capability structured_outputs \
  --min-context 200000 \
  --benchmark agentic.toolathlonVerified \
  --limit 25
```

It parses the snapshot once, joins only explicit source-proven aliases, requires
one offer to satisfy all route gates, and groups observations by `lane_id`.
Records with conflicting release identities are reported as incompatible
observations rather than silently transferred.
An exact `--model` ID takes precedence over aliases, and a record with an
unknown release cannot bridge two different releases through transitive aliases.

To produce a transparent task-specific rank, first inspect the emitted lanes,
then rerun with exact lane IDs and explicit weights:

```bash
node scripts/select-models.mjs --cache /tmp/models-labyrinth \
  --provider openrouter --variant default --effort high \
  --score <lane-id>=3:higher \
  --score <another-lane-id>=1:higher \
  --coverage-penalty 1
```

The selector uses tie-aware percentiles within each lane. It emits an observed
weighted score, evidence coverage, a coverage-adjusted aggregate, confidence,
cohort sizes, and per-lane contributions. A benchmark name that maps to multiple
lanes is rejected until one exact lane is chosen. Confidence is a heuristic,
not a statistical interval or a probability that one model is better. Sample
counts and reported uncertainty stay attached to contributions, but are not
used to establish statistical significance. Claim/aggregate rows and nonnumeric
or missing scores cannot silently enter ranking. Changing cohort membership
can change percentiles even when raw scores are unchanged.

For an explicit quality-versus-price request, add a complete workload and build
the non-dominated front after choosing exact comparison lanes:

```bash
node scripts/select-models.mjs --cache /tmp/models-labyrinth \
  --provider openrouter --effort high \
  --score <quality-lane-id>=3:higher \
  --score <distinct-required-lane-id>=1:higher \
  --pareto quality-cost --profile agentic-multistep \
  --min-task-fit 70 --limit 25
```

Use `--input-tokens`, `--output-tokens`, `--cached-input-ratio`,
`--cache-write-tokens`, `--reasoning-tokens`, and `--requests-per-task` instead
of `--profile` for a custom workload. `--min-task-fit` is a 0–100 floor on the
cohort-relative aggregate score, not a raw benchmark threshold. The output
keeps `pareto_front` and `pareto_unranked` separate. It never treats missing,
ambiguous, scheduled, or incomplete prices as zero. The Pareto mode does not
invent a single “best value” winner: apply a budget or minimum acceptable
quality to choose one point from the front.
Choices with unknown or incompatible workload limits, or non-exact quality
transfer across evaluated and offered effort/quantization, remain unranked.
Neither unknown evaluated quantization nor unknown offered quantization proves
an exact match when the other side is known.
Use `--variant default` when batch, flex, preview, or other route variants are
not acceptable; omit it only when those variants belong in the trade-off set.

Add speed without inventing an aggregate speed score:

```bash
node scripts/select-models.mjs --cache /tmp/models-labyrinth \
  --provider openrouter --variant default \
  --score <quality-lane-id>=1:higher \
  --pareto quality-cost-speed --profile chat-short \
  --speed-scope offer --min-task-fit 70
```

This mode minimizes median TTFT, maximizes median output TPS and quality, and
minimizes workload cost. Both speed values must come from the same runtime
observation; missing either places the choice in `pareto_unranked`. The default
`offer` scope is appropriate for provider selection. Use `--speed-scope model`
only as an explicitly labeled model-level approximation when route metrics are
absent; never present it as provider speed. Median and p50 are treated as the
same statistic, but other percentiles and windows are not mixed.
Objective-equivalent routes are returned as one Pareto point with
`equivalent_choice_count` and `equivalent_offers`, so equal provider choices do
not crowd more informative trade-off points out of the result limit.

If custom analysis still exceeds the selector, parse the snapshot once in one
process and build only the indexes needed for the question. Do not repeatedly
parse the full file for every candidate. Typical joins are:

```text
models[]
  -> offers[] by provider / quantization / effort / capability
  -> benchmarks[] by task-relevant benchmark and comparable conditions
  -> evidence by source and freshness
```

Keep a candidate when a preferred metric is missing if it still satisfies all
hard constraints. Preserve its observed score and report the missing-evidence
coverage penalty separately instead of presenting the penalty as measured model
performance.

## Recommendation quality

A good result distinguishes:

1. hard compatibility: the route can accept the workload;
2. task quality: relevant, comparable benchmark evidence;
3. operational behavior: provider-scoped latency, throughput, uptime, policy, and quantization;
4. economics: full workload cost, including cache and output;
5. evidence confidence: freshness, provenance, independence, and missing fields.

When no candidate dominates, explain the frontier: for example, “A has the best relevant quality evidence, B is materially cheaper for cached prefixes, and C has the strongest route-level latency evidence.” That is more useful than an opaque composite score.
