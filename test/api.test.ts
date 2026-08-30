import { strict as assert } from "node:assert";
import test from "node:test";
import modelsHandler from "../api/v1/models.js";
import modelHandler from "../api/v1/models/[id].js";
import offersHandler from "../api/v1/offers.js";
import facetsHandler from "../api/v1/facets.js";
import benchmarksHandler from "../api/v1/benchmarks.js";
import observationsHandler from "../api/v1/benchmark-observations.js";
import schemaHandler from "../api/v1/schema.js";
import snapshotHandler from "../api/v1/snapshot.js";
import type { ApiResponse } from "../src/api.js";

test("Vercel models handler returns the shared paginated envelope", () => {
  const response = fakeResponse();
  modelsHandler({ url: "/api/v1/models?limit=2&sort=name" }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
  assert.equal((response.body as any).meta.limit, 2);
  assert.ok(Array.isArray((response.body as any).data));
});

test("selection endpoints expose compact model summaries and discoverable facets", () => {
  const modelResponse = fakeResponse();
  modelsHandler({ url: "/api/v1/models?view=summary&limit=1" }, modelResponse);
  assert.equal(modelResponse.statusCode, 200);
  assert.equal((modelResponse.body as any).data[0].offers, undefined);
  assert.ok(Array.isArray((modelResponse.body as any).data[0].providers));

  const facetsResponse = fakeResponse();
  facetsHandler({}, facetsResponse);
  assert.equal(facetsResponse.statusCode, 200);
  assert.ok(Array.isArray((facetsResponse.body as any).data.capabilities));
  assert.ok(Array.isArray((facetsResponse.body as any).data.reasoning_efforts));
});

test("full model pages are capped below the serverless response limit", () => {
  const response = fakeResponse();
  modelsHandler({ url: "/api/v1/models?limit=100" }, response);
  assert.equal((response.body as any).meta.limit, 10);
  assert.equal((response.body as any).data.length, 10);
});

test("benchmark catalog filters canonical entries by kind and alias query", () => {
  const response = fakeResponse();
  benchmarksHandler({ url: "/api/v1/benchmarks?kind=benchmark&q=terminal" }, response);
  assert.equal(response.statusCode, 200);
  assert.ok((response.body as any).data.length > 0);
  assert.ok((response.body as any).data.every((row: any) => row.kind === "benchmark"));
  assert.ok((response.body as any).data.every((row: any) => [row.id, ...(row.aliases ?? [])].some((value: string) => value.toLowerCase().includes("terminal"))));
});

test("offers handler reports invalid custom workloads as client errors", () => {
  const response = fakeResponse();
  offersHandler({ url: "/api/v1/offers?profile=custom&input_tokens=1000" }, response);
  assert.equal(response.statusCode, 400);
  assert.equal((response.body as any).error.parameter, "output_tokens");
  assert.match((response.body as any).error.message, /output_tokens is required/);
});

test("invalid enum values identify the parameter with HTTP 400", () => {
  const response = fakeResponse();
  modelsHandler({ url: "/api/v1/models?scope=fresh" }, response);
  assert.equal(response.statusCode, 400);
  assert.equal((response.body as any).error.parameter, "scope");
});

test("benchmark observations reject mixed-lane score sorts", () => {
  const mixed = fakeResponse();
  observationsHandler({ url: "/api/v1/benchmark-observations?sort=score&limit=1" }, mixed);
  assert.equal(mixed.statusCode, 400);
  assert.equal((mixed.body as any).error.parameter, "sort");

  const listed = fakeResponse();
  observationsHandler({ url: "/api/v1/benchmark-observations?metric=wer&limit=1" }, listed);
  assert.equal(listed.statusCode, 200);
  assert.ok((listed.body as any).data[0].lane_id);
  const laneId = (listed.body as any).data[0].lane_id;
  const sorted = fakeResponse();
  observationsHandler({ url: `/api/v1/benchmark-observations?lane_id=${laneId}&sort=score&limit=1` }, sorted);
  assert.equal(sorted.statusCode, 200);
  assert.equal((sorted.body as any).data[0].lane_id, laneId);
  assert.equal((sorted.body as any).meta.score_direction, "lower");
});

test("malformed model identifiers return an uncached client error", () => {
  const response = fakeResponse();
  modelHandler({ query: { id: "%" } }, response);
  assert.equal(response.statusCode, 400);
  assert.equal((response.body as any).error.parameter, "id");
  assert.equal(response.headers["cache-control"], "no-store");
});

test("models and facets default to available scope metadata", () => {
  const models = fakeResponse();
  modelsHandler({ url: "/api/v1/models?view=summary&limit=1" }, models);
  assert.equal((models.body as any).meta.scope, "available");
  const facets = fakeResponse();
  facetsHandler({ url: "/api/v1/facets" }, facets);
  assert.equal((facets.body as any).meta.scope, "available");
  assert.ok(Array.isArray((facets.body as any).data.capabilities));
});

test("benchmark observations default to available scope and identify mixed comparison lanes", () => {
  const listed = fakeResponse();
  observationsHandler({ url: "/api/v1/benchmark-observations?limit=1" }, listed);
  assert.equal(listed.statusCode, 200);
  assert.equal((listed.body as any).meta.scope, "available");
  assert.ok((listed.body as any).data[0].lane_id);
});

test("schema handler exposes the same JSON Schema contract", () => {
  const response = fakeResponse();
  schemaHandler({}, response);
  assert.equal(response.statusCode, 200);
  assert.equal((response.body as any).$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.ok((response.body as any).$defs.model);
  assert.deepEqual((response.body as any).$defs.api_meta.properties.scope.enum, ["available", "all"]);
  assert.equal((response.body as any).$defs.comparison_lane.required.includes("lane_id"), true);
});

test("snapshot endpoint redirects to the static full JSON", () => {
  const response = fakeResponse();
  snapshotHandler({}, response);
  assert.equal(response.statusCode, 302);
  assert.equal(response.headers.location, "/api/v1/snapshot.json");
});

test("snapshot endpoint can redirect to an externally published full JSON", () => {
  const previous = process.env.SNAPSHOT_DOWNLOAD_URL;
  process.env.SNAPSHOT_DOWNLOAD_URL = "https://raw.githubusercontent.com/example/models/main/models_db.json";
  try {
    const response = fakeResponse();
    snapshotHandler({}, response);
    assert.equal(response.headers.location, "https://raw.githubusercontent.com/example/models/main/models_db.json");
  } finally {
    if (previous === undefined) delete process.env.SNAPSHOT_DOWNLOAD_URL;
    else process.env.SNAPSHOT_DOWNLOAD_URL = previous;
  }
});

function fakeResponse(): ApiResponse & { statusCode: number; headers: Record<string, string>; body?: unknown } {
  const response = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(code: number) { response.statusCode = code; return response; },
    setHeader(name: string, value: string) { response.headers[name.toLowerCase()] = value; return response; },
    json(value: unknown) { response.body = value; },
    end(value?: string) { response.body = value; },
  };
  return response;
}
