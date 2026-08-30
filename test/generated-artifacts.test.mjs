import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { loadSnapshot } from "../src/db.ts";
import { MODELS_DB_SCHEMA } from "../src/schema.ts";
import { health, listFacets, listModels, listOffers } from "../src/query.ts";

test("archive, built runtime, static snapshot and health expose the same verified generation", async () => {
  const schema = JSON.parse(await readFile("public/api/v1/schema.json", "utf8"));
  assert.deepEqual(schema, MODELS_DB_SCHEMA);
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allowUnionTypes: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const project = (snapshot) => ({
    health: health(snapshot),
    models: listModels(snapshot, new URLSearchParams("view=summary&capability=tools&sort=context&limit=5")),
    offers: listOffers(snapshot, new URLSearchParams("profile=chat-short&sort=cost&limit=5")),
    facets: listFacets(snapshot),
  });
  const archive = loadSnapshot({ path: "models_db.json" });
  assert.equal(validate(archive), true, JSON.stringify(validate.errors));
  const largestPageBytes = archive.models.map((model) => Buffer.byteLength(JSON.stringify(model)))
    .sort((a, b) => b - a).slice(0, 10).reduce((total, size) => total + size, 0);
  // Leave room for the envelope under Vercel's 4.5 MB response-body limit.
  assert.ok(largestPageBytes < 4_400_000, "full model pages exceed the response budget; reduce their cap or change the projection");
  const expected = project(archive);
  for (const path of ["runtime-query.json", "public/api/v1/snapshot.json"]) {
    const snapshot = loadSnapshot({ path }); // Recomputes SHA-256 and validates nested records.
    assert.equal(validate(snapshot), true, `${path}: ${JSON.stringify(validate.errors)}`);
    assert.deepEqual(project(snapshot), expected, path);
  }
  assert.deepEqual(JSON.parse(await readFile("public/api/v1/health.json", "utf8")), expected.health);
});

test("published JSON Schema rejects malformed nested routing and score values", () => {
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allowUnionTypes: true });
  addFormats(ajv);
  ajv.addSchema(MODELS_DB_SCHEMA);
  const price = ajv.compile({ $ref: `${MODELS_DB_SCHEMA.$id}#/$defs/price` });
  assert.equal(price({ dimension: "input", unit: "million_tokens", amount_usd_per_unit: -1, raw: -1, kind: "fixed" }), false);
  const benchmark = ajv.compile({ $ref: `${MODELS_DB_SCHEMA.$id}#/$defs/benchmark_observation` });
  const evidence = { source_id: "fixture", url: "https://fixture.example", fetched_at: "2026-08-31T00:00:00Z", status: "observed" };
  assert.equal(benchmark({ benchmark_id: "fixture", value: null, evidence }), false);
  assert.equal(benchmark({ benchmark_id: "fixture", value: -10, sample_count: 2.5, evidence }), false);
  assert.equal(benchmark({ benchmark_id: "fixture", value: -10, sample_count: 2, evidence }), true);
  const runtime = ajv.compile({ $ref: `${MODELS_DB_SCHEMA.$id}#/$defs/runtime` });
  assert.equal(runtime({ scope: "offer", uptime_fraction: { value: 99.5 }, evidence }), false);
});
