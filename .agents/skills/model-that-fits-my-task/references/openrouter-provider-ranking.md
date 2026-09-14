# OpenRouter provider-ranking handoff

Use the repository's sibling [`openrouter-provider-ranking`](../../openrouter-provider-ranking/SKILL.md) skill after Models Labyrinth has selected one or a small number of exact OpenRouter model slugs and the remaining question is which OpenRouter endpoint provider or routing mode should serve the workload.

Both skills are maintained in this repository. Follow the provider-ranking skill directly; do not recreate its scoring formula from memory. To install that skill independently when permitted, use:

```bash
npx skills add rodion-m/model-that-fits-my-task@openrouter-provider-ranking -g -y
```

## Handoff trigger

Hand off when at least one of these is material:

- several endpoint providers expose the same OpenRouter model slug;
- quantization, context, supported parameters, privacy, or fallback diversity can eliminate routes;
- the decision depends on provider-scoped TPS, TTFT, uptime, cache behavior, or effective workload cost;
- the user needs `provider.order`, `provider.only`, `:exacto`, or a choice between native OpenRouter routing and a pinned chain.

Do not hand off merely because OpenRouter is one available catalog provider. Finish model-family selection first. The provider-ranking skill is intentionally scoped to endpoint routing for a known model slug, not broad model-quality comparison. Once the user needs a deployable OpenRouter recommendation and several routes are viable, the handoff is mandatory and its result must return to the main decision.

## Handoff contract

Pass the exact OpenRouter model slug and the constraints already established:

- tool and structured-output requirements, streaming, required parameters, context, and output limits;
- prompt, completion, cache-read, and cache-write token profile plus requests per task/session;
- acceptable reasoning efforts and quantizations; ask it to compare `endpoint × effort`, not endpoints with one inherited effort;
- hard caps for cost, TTFT, throughput, uptime, privacy/ZDR, moderation, and data collection;
- optimization goal and whether deterministic failover is required;
- relevant published provider observations and their freshness.

Keep Models Labyrinth benchmark evidence attached to the model decision. Let the provider-ranking skill own endpoint compatibility, workload pricing, provider runtime comparison, uncertainty, routing mode, and fallback ordering.

Require the handoff result to name the exact provider route, service tier, quantization, reasoning configuration, structured-output status, cache semantics, policy status, fallback mode, and workload price. `Unknown` is a result; a missing dimension is not. Check that a cheaper default tier was not discarded merely because a similarly priced `flex` tier was filtered. Do not treat a provider's model-wide benchmark as evidence for a quantized endpoint unless the evaluated configuration matches.

## Evidence boundary

The Models Labyrinth workflow does not spend provider credits or create private benchmark, latency, or cache measurements. When this reference is used under that constraint:

- rank only from current published catalog/API evidence and any telemetry the user explicitly supplies;
- mark the endpoint order as a hypothesis where the upstream skill calls for real-request verification;
- include a workload-shaped verification plan: by default 10 sequential representative requests plus 2 concurrent requests, with first-attempt 429/`Retry-After` capture; do not execute it without separate user authorization;
- for agentic workloads, inspect any route-scoped cache hit observation and propose a stable-prefix real run that reports request hit rate and token hit ratio;
- reject latency or throughput values whose source, timestamp, percentile, or unit cannot be verified; empty endpoint stats stay unknown;
- treat `null` ZDR/data-collection fields and undocumented cache writes as unknown, even when request-time policy flags can be configured;
- never infer a missing provider metric, cache hit rate, Exacto score, or quantization quality impact.

The upstream skill may require `OPENROUTER_API_KEY` for live endpoint discovery. Read it only from the environment; never place it in prompts, output, configs, logs, or repository files.
