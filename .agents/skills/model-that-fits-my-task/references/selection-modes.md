# Selection modes

Choose the decision mode before inspecting winners. These modes answer different questions and must not be treated as nested age buckets.

| Mode | Use when | Candidate rule |
| --- | --- | --- |
| `competitive` | Default; the user wants the best practical choice, especially when cost, latency, throughput, or context matter | Apply hard constraints and a task-relevant quality floor, then keep non-dominated `model × offer × effort` pairs. Price, speed, popularity, or availability cannot rescue a model below the floor. |
| `frontier` | The user explicitly asks for maximum quality, best possible results, or accepts materially higher cost for quality | Search only the task-relevant frontier cohort. Rank primarily by the closest current benchmark evidence; report economics and operations, but do not admit weaker models because they are cheaper. |
| `available` | Rarely: benchmark coverage is too sparse, the task is capability inventory, or the user asks what can actually be deployed through a provider | Use `scope=available` only to expand or inspect the candidate universe. It is not a recommendation class; apply quality evidence before returning a choice. |
| `all` | Almost never: explicit historical comparison, supersession analysis, reproducibility, audit, or exhaustive catalog export | Use `scope=all`. Expect unavailable, unresolved, obsolete, and offerless records. Never fall back to it merely because the normal query was inconvenient or empty. |

`competitive` and `frontier` are task-conditioned decisions, not fields stored on a model. A model can be frontier for one task and irrelevant for another. A currently sold older model can remain in `available` while being dominated in every practical recommendation.

For `competitive`, establish the quality floor before looking at price. Use the closest end-to-end current lane and retain models within a defensible task-specific band of the leading result; add a second lane only when it measures a distinct required capability. If the evidence cannot justify a numeric band, use a disclosed qualitative gate and lower confidence. Then compare cost per workload, latency/throughput, context, cache economics, structured-output evidence, policy, quantization, and provider reliability as separate Pareto dimensions.

For “best quality at the lowest price,” build a two-objective front after that gate: maximize the disclosed task-fit score and minimize estimated cost for the user's full workload. A point is dominated only when another eligible `model × offer × configuration` is at least as good on quality, no more expensive, and strictly better on one objective. Return the whole front by default. Choose one point only after applying an explicit budget, minimum quality, or disclosed quality-to-cost preference. Keep incomplete-cost choices outside the mathematical front and label them unranked; unknown is not zero cost.

Unknown or incompatible workload limits, and unverified transfer between evaluated and offered effort/quantization, also remain unranked. They must not dominate routes with verified compatibility.

When speed is material, use `quality-cost-speed` and keep median TTFT and median output TPS as separate objectives: minimize TTFT and maximize TPS. Do not compress them into one speed score or combine values from different routes, windows, percentiles, or observations. Offer scope is the provider-selection default; model scope is an explicit approximation and cannot prove route speed. TTFA and speech TTFS are not substitutes for TTFT.

Do not build `competitive` by first listing frontier models and adding cheap models. Do not build `frontier` by filtering the available catalog by release date. Both require current, task-relevant quality evidence.
