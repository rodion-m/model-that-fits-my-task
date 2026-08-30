# Benchmark decision playbook

Read this reference when choosing quality evidence for a general workload. Apply the benchmark status map named in `SKILL.md` first. Confirm current canonical IDs through `/benchmarks?kind=benchmark&q=<name>`; benchmark names are a reading order, not a fixed allowlist.

## Evidence order

Prefer a primary-current benchmark that reproduces the task, then a qualified or task-specific current benchmark. Use a coverage anchor only when direct current evidence is absent, and never silently substitute legacy evidence. Never optimize a proxy past its scope: GPQA is not an agent benchmark, IFEval is not schema reliability, ScreenSpot is not computer-use success, LiveCodeBench is not repository maintenance, and advertised context is not retrieval quality.

| Workload | Quality evidence to prioritize | Conditions to preserve |
| --- | --- | --- |
| Production repository work | DeepSWE v1.1 and SWE-rebench v2; FrontierCode 1.1 for mergeability; Terminal-Bench 3.0 only for terminal-heavy work | Repository revision, scaffold, tools, timeout, verifier, effort, cost, and run statistic; FrontierCode is private/source-run; SWE-bench Pro is only a disputed coverage anchor and SWE-bench Verified is legacy |
| General current reasoning, coding, and agentic coding | LiveBench release task lanes, when the task matches one of its subtasks; use its coding and agentic-coding rows separately | Release, exact subtask, effort, evaluator, and model configuration; LiveBench category/overall rows are derived aggregates, not independent tasks |
| Algorithms or isolated code | LiveCodeBench v6/Pro; BigCodeBench only for dependency-rich function work; SciCode only for scientific code; ProgramBench only for black-box reimplementation | Compiler/runtime, pass@k, cutoff, effort, token budget, output price |
| Tool and MCP workflows | Toolathlon-Verified, MCP-Atlas, τ³-bench; BFCL v4 for call/schema mechanics | Exact tools, service state, parameters, retries, context growth, route uptime and latency |
| Desktop/mobile computer use | OSWorld 2.0, MobileWorld, WebArena-Verified; ScreenSpot-Pro only for grounding | VM/app release, vision/action interface, state reset, evaluator, task success |
| Math and abstract reasoning | FrontierMath V2 Tiers 1–3/Tier 4, AIME/HMMT/IMO 2026, ARC-AGI-3, CritPt | Python/tools, effort, token or interaction budget, contest year, answer extractor |
| Research, science, factual QA | AA-Omniscience for accuracy/hallucination/abstention; CritPt/FrontierScience; HLE/GPQA as anchors; BrowseComp only with browsing | Search and citations, freshness, grader, abstention policy, context, domain coverage |
| Structured output and extraction | SOB value accuracy; LiquidExtract Schema F1, JSON Validity, and VLM Judge; IFBench/IFEval only for general constraints | Exact route parameter, modality, schema complexity, parser, retries, latency, cost |
| Long context and RAG | MRCR v2 matching the context bin, CorpusQA 1M, GraphWalks 128K, AA-LCR; domain QA second | Packing, position, retrieval/oracle access, truncation, TTFT, cache economics |
| Documents, OCR, charts, UI | OCRBench V2, OmniDocBench 1.5, OfficeQA Pro/GDP.pdf, CharXiv, ScreenSpot-Pro, Vision2Web; MMMU-Pro for breadth | Original files versus renders, OCR/parser/tools, image limits and pricing, judge, version |
| Enterprise PDF parsing and extraction | ParseBench for agent-ready PDF parsing across tables, charts, faithfulness, semantic formatting, and visual grounding; ExtractBench for schema-guided value F1, length splits, precision/recall, evidence grounding, latency, and cost | Evaluation system/pipeline, document split, schema complexity, source evidence, output contract, grounding level, latency and per-page evaluation cost; pipeline leaderboard rows without a deployable model offer are benchmark evidence only |
| Multilingual work | MMLU-ProX, INCLUDE, NOVA-63, Global-MMLU, MILU, MaXIFE; SWE-bench Multilingual for repositories | Exact languages, native versus translated items, prompt language, aggregation, tokenizer cost |
| Speech-to-text and voice agents | English streaming: Pipecat semantic WER, transcript/perfect rates, and TTFS P50/P95/P99; batch/non-streaming: Artificial Analysis AA-WER and matching Open ASR WER/RTFx; multilingual: Open ASR exact language × dataset lanes | Target language, streaming versus batch, provider/model route, semantic versus raw WER, dataset, sample count, and row-specific runtime hardware when published; current Open ASR multilingual rows cover de/fr/it/es/pt rather than every dataset language |
| Creative or subjective writing | Direct writing/preference evaluations such as Lech-Mazur or a relevant arena | Audience and style, output length, judge population; preference scores are audience-dependent |

For finance, legal, healthcare, education, public services, office artifacts, SaaS automation, customer service, HR, IT operations, cybersecurity, consulting, or modernization, return to the route map and use the business-domain playbook instead.

## Release boundaries

Do not mix ARC-AGI 1/2/3, Terminal-Bench 2.0/2.1/3, OSWorld/Verified/2.0, FrontierMath legacy/V2, τ-bench releases or domains, or tool/no-tool lanes. Keep benchmark releases distinct unless the catalog explicitly represents a metric, evaluator, or variant of one canonical release.

When no close benchmark exists, say so and lower confidence instead of synthesizing a universal score. Use broad evidence only as a tie-breaker or prior, never as proof of performance on an uncovered workflow. LiveBench evaluation cost/token fields describe the published benchmark run; use offer pricing and workload estimates for deployment economics.

Do not produce benchmark laundry lists. Cite only the two to five current signals
that represent the user's deliverable and materially affect the recommendation.
Aider Polyglot, HumanEval, and SWE-bench Verified are not default coding signals;
their presence in a catalog or search result is not a reason to mention them.

## Task-fit scoring

Use an aggregate only after hard route constraints leave a meaningful cohort.
For the default `competitive` mode, apply the closest end-to-end quality lane as
a floor before price, latency, or popularity enters the comparison; then score
or Pareto-rank the survivors. For an explicit maximum-quality request, restrict
the cohort to task-relevant frontier models and do not add cheaper non-frontier
models. `scope=available` supplies deployable records but defines neither cohort.
Choose two to five benchmarks that directly represent the deliverable and select
one exact `lane_id` for each. Give the closest end-to-end benchmark the largest
weight; use broad knowledge or legacy anchors only as small tie-breakers. Record
weights before looking at the winner.

The selector normalizes each lane with a tie-aware empirical percentile, then
reports:

```text
observed_score = sum(weight × percentile) / sum(weight present)
coverage = sum(weight present) / sum(weight requested)
aggregate_score = observed_score × coverage ^ coverage_penalty
```

Use `coverage_penalty=1` unless the user explicitly prefers a more tolerant or
more conservative evidence policy. Missing evidence lowers coverage; it is not a
measurement of poor performance. `confidence` also reflects cohort size and
whether evidence is observed or derived; claim and aggregate rows are rejected.
Confidence is a heuristic, not a statistical interval or success probability.
Empirical percentiles depend on the cohort, and small score differences do not
establish significance even when published sample counts are attached. Always show observed score,
coverage, confidence, cohort sizes, and contributions beside the aggregate.

Example after discovering exact lane IDs:

```bash
node scripts/select-models.mjs --cache /tmp/models-labyrinth \
  --provider openrouter --capability tools --effort high \
  --score <terminal-bench-lane-id>=3:higher \
  --score <toolathlon-lane-id>=2:higher \
  --score <cost-or-error-lane-id>=1:lower
```

Vary each material weight by roughly ±25% and report whether the winner changes.
Do not combine different efforts, evaluators, dataset versions, metrics, or
harness configurations behind one benchmark name. If only one model is present
in a lane, its percentile is neutral (50) and confidence is low.
