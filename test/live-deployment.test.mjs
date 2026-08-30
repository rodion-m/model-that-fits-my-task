import assert from "node:assert/strict";
import test from "node:test";

const live = process.env.LIVE_TESTS === "1";
const base = (process.env.MODELS_LABYRINTH_API_BASE ?? "https://models-labyrinth.vercel.app/api/v1").replace(/\/$/, "");

test("deployed API supports the skill navigation contract", { skip: !live, timeout: 60_000 }, async () => {
  const health = await getJson("/health");
  assert.equal(health.status, "ok");
  assert.ok(health.content_hash);
  assert.equal(health.default_scope, "available");

  const schema = await getJson("/schema");
  assert.deepEqual(schema.$defs.api_meta.properties.scope.enum, ["available", "all"]);
  assert.ok(schema.$defs.comparison_lane);

  const facets = await getJson("/facets");
  assert.ok(Array.isArray(facets.data.capabilities));
  assert.ok(Array.isArray(facets.data.modalities));
  assert.equal(facets.meta.scope, "available");

  const models = await getJson("/models?view=summary&provider=openrouter&modality=input%3Atext&limit=1");
  assert.equal(models.data.length, 1);
  assert.equal(models.data[0].offers, undefined);
  assert.ok(models.data[0].identity_confidence);
  assert.equal(models.meta.scope, "available");

  const all = await getJson("/models?scope=all&view=summary&provider=openrouter&modality=input%3Atext&limit=1");
  assert.equal(all.meta.scope, "all");
  assert.ok(all.meta.total >= models.meta.total);

  const invalidScope = await request("/models?scope=fresh");
  assert.equal(invalidScope.status, 400);
  const invalidBody = await invalidScope.json();
  assert.equal(invalidBody.error.parameter, "scope");

  const invalid = await request("/offers?profile=custom&input_tokens=1000");
  assert.equal(invalid.status, 400);
  await invalid.arrayBuffer();

  const modelId = models.data[0].id;
  const offers = await getJson(`/offers?model=${encodeURIComponent(modelId)}&provider=openrouter&profile=custom&input_tokens=10000&output_tokens=300&sort=cost&limit=1`);
  assert.equal(offers.data[0]?.model_id, modelId);
  assert.equal(offers.data[0]?.workload_profile?.input_tokens, 10_000);
  assert.equal(offers.meta.scope, "available");

  const mixed = await request("/benchmark-observations?sort=score&limit=1");
  assert.equal(mixed.status, 400);
  const mixedBody = await mixed.json();
  assert.equal(mixedBody.error.parameter, "sort");

  const observations = await getJson("/benchmark-observations?metric=wer&limit=1");
  assert.equal(observations.meta.scope, "available");
  assert.ok(observations.data[0].lane_id);
  const lane = await getJson(`/benchmark-observations?lane_id=${observations.data[0].lane_id}&sort=score&limit=1`);
  assert.equal(lane.data[0].lane_id, observations.data[0].lane_id);
  assert.ok(lane.data[0].evidence);
  assert.equal(lane.meta.score_direction, "lower");
});

function request(path) {
  return fetch(`${base}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
}

async function getJson(path) {
  const response = await request(path);
  assert.equal(response.status, 200, `${path} returned HTTP ${response.status}`);
  return response.json();
}
