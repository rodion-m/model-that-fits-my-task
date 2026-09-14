---
name: model-that-fits-my-task
description: Select and compare AI models and provider routes using current Models Labyrinth evidence. Use when a user asks which model or provider to use, asks to rank models, needs alternatives or speed-cost trade-offs, or compares benchmark quality, reasoning effort, quantization, context, structured output, latency, throughput, price, cache behavior, privacy, open weights, or workload budget. Do not use for generic model news, API troubleshooting, or running local evaluations.
---

# Model That Fits My Task

Recommend a deployable `model × provider offer × configuration` from published evidence. Keep quality separate from provider behavior until the task defines the trade-off.

## Data access

- Query API: `https://models-labyrinth.vercel.app/api/v1`
- Static mirror: `https://rodion-m.github.io/model-that-fits-my-task/api/v1`
- Full snapshot: `https://rodion-m.github.io/model-that-fits-my-task/api/v1/snapshot.json`
- JSON Schema: `https://rodion-m.github.io/model-that-fits-my-task/api/v1/schema.json`

Use Vercel for filters and GitHub Pages for full downloads. Start with `/health`; report `generated_at` and failed/stale sources. `scope=available` is a deployability inventory, not a shortlist; `scope=all` is almost never appropriate except for explicit historical or audit work.

## Decision loop

1. Translate the request into constraints and preferences: task, modality, context, tools, structured output, privacy, open weights, provider, quantization, effort, latency, throughput, cache, and workload cost.
2. Ask one focused question only when a missing constraint could reverse the choice. Otherwise state assumptions.
3. Choose a mode using [selection-modes.md](references/selection-modes.md). Default to `competitive`; for explicit maximum quality, use `frontier` and search only the task-relevant frontier cohort. Use `available` rarely to expand the pool and `all` only for historical catalog access.
4. Read [benchmark-status-map.md](references/benchmark-status-map.md), then the narrowest playbook: [benchmark-decision-playbook.md](references/benchmark-decision-playbook.md) for general workloads or [business-domain-playbook.md](references/business-domain-playbook.md) for professional domains.
5. Use `/facets?scope=available` for discovery, then apply provider, capability, effort, context, parameter, runtime, cache, policy, and quantization gates to one `/offers?scope=available` record. Do not prove route compatibility from aggregated model fields.
6. Use `/benchmark-observations?scope=available` for quality. Compare values only inside one source-specific `lane_id`; preserve score direction and never transfer a score across model versions. Use disclosed task weights only for the separate cohort-relative scoring procedure.
7. Compare surviving `offer × reasoning configuration` pairs on full workload cost and route-scoped operational evidence. Provider choice and effort are decision dimensions, not follow-up details.
8. For quality/price or quality/price/speed trade-offs, run the corresponding Pareto mode after the quality gate and return the whole front unless a hard threshold selects one point.
9. Attach the workload-shaped plan from [operational-validation.md](references/operational-validation.md); agentic choices include cache-hit assessment.
10. Run the completion gate below before every recommendation. Validate a small JSON decision artifact before prose; there is no model-only shortcut.

For filters, pagination, and offline snapshot work, read [data-guide.md](references/data-guide.md). Use the filtered API first.

After choosing an OpenRouter model slug, read the handoff contract in [openrouter-provider-ranking.md](references/openrouter-provider-ranking.md) and use the sibling [`openrouter-provider-ranking`](../openrouter-provider-ranking/SKILL.md) skill when several routes are viable. That skill owns endpoint compatibility, `endpoint × reasoning effort` ranking, routing mode, and fallback order. Integrate its exact route into this skill's model recommendation; route economics cannot retroactively change the model-quality claim.

## Comparison rules

- Apply hard gates before preferences. Missing data is unknown, never false, zero, free, or poor.
- Never infer competitiveness from age, availability, popularity, price, or speed. Apply a task-relevant quality floor first; cheap or fast models below it remain excluded. Within `competitive`, compare the surviving Pareto set on workload economics and operations. Within explicit `frontier`, quality leads and cost is reported rather than used to admit weaker models.
- Apply the benchmark modernity gate before looking at scores. Prefer `primary current`, then `current qualified` or exact `task-specific` evidence. Coverage anchors require a disclosed coverage gap; legacy benchmarks require an explicit historical or exact-harness request.
- Prefer the narrowest current benchmark that reproduces the deliverable, tools, policy, modality, and domain. Broad indices are context; `aggregate` and `claim` rows are not independent ranking evidence.
- For audio/STT, identify the target language and streaming versus batch use first. WER is lower-is-better; keep Pipecat TTFS, Artificial Analysis WER, and Open ASR RTFx as separate lanes. A multilingual average does not prove performance for a language that has no published lane.
- For document tasks, distinguish PDF parsing (ParseBench) from schema-guided extraction (ExtractBench); preserve exact split, configuration, costs, latency, and model IDs, and treat pipeline-only rows as benchmark evidence, not deployable offers.
- Exclude Aider Polyglot, HumanEval, SWE-bench Verified, and other legacy lanes by default; allow them only for explicit historical or exact-harness requests.
- Resolve canonical IDs through `/benchmarks`. `source_benchmark_ids` are aliases or provenance, not extra votes.
- Use canonical identities and source-proven aliases. Never normalize punctuation, strip versions, merge variants ad hoc, or transfer evidence across versions.
- Treat a score as `model × harness × tools × configuration`, not automatically as a base-model property.
- A declared capability such as structured outputs or tools is support metadata, not measured reliability.
- Quantization belongs to an offer. Do not transfer an unquantized score without labeling the quality impact unknown.
- Compare OpenRouter candidates as `endpoint × effort`, not endpoint alone. Never copy an effort from the incumbent or another model. If the route exposes only Boolean reasoning, say that named effort is unsupported.
- Cost must reflect input/output, cache read/write billing semantics, reasoning, requests, tiers, and material non-text media. Reads plus writes cannot exceed total input tokens. A `null` estimate is unknown; unknown workload compatibility or quality transfer cannot dominate a verified route in the Pareto front.
- Prefer observed evidence over derived data and trace `derived_from`. Republished scores do not become independent confirmations.
- For ranked results, use the selector's cohort-relative task-fit score with exact lanes and explicit weights; report score, coverage, confidence, and contributions. Confidence is a heuristic, not statistical significance; percentiles change with the cohort.
- Cite only evidence that materially affected the ranking. Do not answer with a benchmark catalog or mention irrelevant legacy scores merely because they exist.
- Always propose bounded operational validation; never spend credits without explicit authorization.

For snapshot work, use the bundled downloader or selector; never fetch bundle files independently. Its `content_hash` identifies the evidence. High-stakes choices still need qualified, organization-specific validation.

## Completion gate

A recommendation must state model, exact offer, reasoning configuration, output contract, operations, economics, benchmark transfer, and operational validation. Explained `unknown`, `unsupported`, or `not applicable` is acceptable; omission is not. Lead with `model × provider route × effort`.

Before answering, read [decision-completion.md](references/decision-completion.md), write the decision artifact, and run its validator; do not answer before it passes.

## Response contract

Lead with the decision. For every recommendation include:

- exact model, provider model id, route/routing mode, service tier, quantization, and reasoning effort/configuration;
- why it fits the workload and which hard constraints it satisfies;
- relevant quality, runtime, context, price/cache, capability, provenance, and freshness evidence;
- the largest trade-off or uncertainty;
- comparison `lane_id`, explicit decision weights when used, task-fit score with coverage/confidence, and whether sensitivity changes the winner;
- a direct Models Labyrinth record or reproducible query.

End with assumptions and material evidence gaps. Use ranges or qualitative confidence when sources are not directly comparable.
