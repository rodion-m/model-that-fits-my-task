#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const STATUSES = {
  offer: new Set(["selected", "unresolved"]),
  reasoning: new Set(["selected", "unsupported", "unknown", "not_applicable"]),
  evidence: new Set(["measured", "declared", "unsupported", "unknown", "not_applicable"]),
  transfer: new Set(["exact", "partial", "unknown"]),
  cost: new Set(["estimated", "unknown"]),
  cacheHitRate: new Set(["observed", "claimed", "unknown"]),
  operationalValidation: new Set(["proposed", "completed", "blocked"]),
};

const WORKLOAD_KINDS = new Set(["interactive", "rag", "agentic", "batch", "other"]);

export function validateDecision(document) {
  const errors = [];
  if (!Array.isArray(document?.recommendations) || document.recommendations.length === 0) {
    return ["recommendations must be a non-empty array"];
  }

  document.recommendations.forEach((recommendation, index) => {
    const at = `recommendations[${index}]`;
    requireText(recommendation?.model_id, `${at}.model_id`, errors);
    validateWorkload(recommendation?.workload, `${at}.workload`, errors);
    requireStatus(recommendation?.offer, STATUSES.offer, `${at}.offer`, errors);
    if (recommendation?.offer?.status === "selected") {
      for (const field of ["provider_id", "provider_model_id", "route"]) {
        requireText(recommendation.offer[field], `${at}.offer.${field}`, errors);
      }
      requireOwn(recommendation.offer, "service_tier", `${at}.offer.service_tier`, errors);
      requireOwn(recommendation.offer, "quantization", `${at}.offer.quantization`, errors);
    } else {
      requireText(recommendation?.offer?.reason, `${at}.offer.reason`, errors);
    }

    requireStatus(recommendation?.reasoning, STATUSES.reasoning, `${at}.reasoning`, errors);
    if (recommendation?.reasoning?.status === "selected") {
      requireText(recommendation.reasoning.effort, `${at}.reasoning.effort`, errors);
    } else {
      requireText(recommendation?.reasoning?.reason, `${at}.reasoning.reason`, errors);
    }

    for (const field of ["structured_output", "cache", "privacy", "runtime"]) {
      requireStatus(recommendation?.[field], STATUSES.evidence, `${at}.${field}`, errors);
      requireText(recommendation?.[field]?.evidence, `${at}.${field}.evidence`, errors);
    }
    if (recommendation?.workload?.kind === "agentic") {
      validateCacheHitRate(recommendation?.cache?.hit_rate, `${at}.cache.hit_rate`, errors);
    }

    requireStatus(recommendation?.quality_transfer, STATUSES.transfer, `${at}.quality_transfer`, errors);
    requireText(recommendation?.quality_transfer?.evidence, `${at}.quality_transfer.evidence`, errors);
    requireOwn(recommendation?.quality_transfer, "lane_id", `${at}.quality_transfer.lane_id`, errors);
    if (recommendation?.quality_transfer?.status === "exact") requireText(recommendation.quality_transfer.lane_id, `${at}.quality_transfer.lane_id`, errors);

    requireStatus(recommendation?.cost, STATUSES.cost, `${at}.cost`, errors);
    requireText(recommendation?.cost?.assumptions, `${at}.cost.assumptions`, errors);
    if (recommendation?.cost?.status === "estimated") requireRange(recommendation.cost.estimated_cost_usd, `${at}.cost.estimated_cost_usd`, errors, 0, Number.MAX_VALUE);
    requireText(recommendation?.tradeoff, `${at}.tradeoff`, errors);
    validateOperationalValidation(
      recommendation?.operational_validation,
      recommendation?.offer?.status,
      recommendation?.workload?.kind,
      `${at}.operational_validation`,
      errors,
    );
    if (Object.hasOwn(recommendation ?? {}, "task_fit")) validateTaskFit(recommendation.task_fit, `${at}.task_fit`, errors);
    if (!Array.isArray(recommendation?.sources) || recommendation.sources.length === 0) {
      errors.push(`${at}.sources must be a non-empty array`);
    } else recommendation.sources.forEach((source, sourceIndex) => requireText(source, `${at}.sources[${sourceIndex}]`, errors));
  });
  return errors;
}

function validateWorkload(value, path, errors) {
  if (!value || !WORKLOAD_KINDS.has(value.kind)) {
    errors.push(`${path}.kind must be one of: ${[...WORKLOAD_KINDS].join(", ")}`);
  }
  requireText(value?.profile, `${path}.profile`, errors);
}

function validateCacheHitRate(value, path, errors) {
  requireStatus(value, STATUSES.cacheHitRate, path, errors);
  requireOwn(value, "value", `${path}.value`, errors);
  requireText(value?.scope, `${path}.scope`, errors);
  requireText(value?.evidence, `${path}.evidence`, errors);
  if (value?.status === "unknown" && value.value !== null) {
    errors.push(`${path}.value must be null when status is unknown`);
  }
  if (["observed", "claimed"].includes(value?.status)
    && (typeof value.value !== "number" || !Number.isFinite(value.value) || value.value < 0 || value.value > 1)) {
    errors.push(`${path}.value must be a finite ratio between 0 and 1 when status is observed or claimed`);
  }
}

function validateOperationalValidation(value, offerStatus, workloadKind, path, errors) {
  requireStatus(value, STATUSES.operationalValidation, path, errors);
  if (offerStatus === "selected" && value?.status === "blocked") {
    errors.push(`${path}.status cannot be blocked for a selected offer`);
  }
  if (offerStatus !== "selected") {
    if (value?.status !== "blocked") errors.push(`${path}.status must be blocked while the offer is unresolved`);
    requireText(value?.reason, `${path}.reason`, errors);
    return;
  }
  for (const [field, minimum] of [["sequential_requests", 1], ["parallel_requests", 2], ["parallel_concurrency", 2]]) {
    if (!Number.isInteger(value?.[field]) || value[field] < minimum) errors.push(`${path}.${field} must be an integer >= ${minimum}`);
  }
  if (Number.isInteger(value?.parallel_requests) && Number.isInteger(value?.parallel_concurrency)
    && value.parallel_concurrency > value.parallel_requests) {
    errors.push(`${path}.parallel_concurrency cannot exceed parallel_requests`);
  }
  requireText(value?.profile_basis, `${path}.profile_basis`, errors);
  requireText(value?.acceptance, `${path}.acceptance`, errors);
  if (!Array.isArray(value?.checks)) {
    errors.push(`${path}.checks must be an array`);
  } else {
    for (const required of ["http_429", "retry_after"]) {
      if (!value.checks.includes(required)) errors.push(`${path}.checks must include ${required}`);
    }
  }
  if (typeof value?.cache_hit_measurement !== "boolean") errors.push(`${path}.cache_hit_measurement must be a boolean`);
  if (workloadKind === "agentic" && value?.cache_hit_measurement !== true) {
    errors.push(`${path}.cache_hit_measurement must be true for agentic workloads`);
  }
  if (typeof value?.requires_authorization !== "boolean") errors.push(`${path}.requires_authorization must be a boolean`);
  if (value?.status === "proposed" && value.requires_authorization !== true) {
    errors.push(`${path}.requires_authorization must be true while validation is only proposed`);
  }
  if (value?.status === "completed") {
    requireNonNegativeInteger(value?.observations?.attempted_requests, `${path}.observations.attempted_requests`, errors, 1);
    requireNonNegativeInteger(value?.observations?.http_429_count, `${path}.observations.http_429_count`, errors, 0);
    if (value?.observations?.http_429_count > value?.observations?.attempted_requests) errors.push(`${path}.observations.http_429_count cannot exceed attempted_requests`);
    if (value?.observations?.attempted_requests < value.sequential_requests + value.parallel_requests) errors.push(`${path}.observations.attempted_requests is smaller than the completed plan`);
  }
}

function validateTaskFit(value, path, errors) {
  for (const field of ["aggregate_score", "observed_score", "coverage", "confidence"]) {
    requireRange(value?.[field], `${path}.${field}`, errors, 0, ["coverage", "confidence"].includes(field) ? 1 : 100);
  }
  if (!Array.isArray(value?.contributions) || value.contributions.length === 0) {
    errors.push(`${path}.contributions must be a non-empty array`);
  } else {
    value.contributions.forEach((contribution, index) => {
      requireText(contribution?.lane_id, `${path}.contributions[${index}].lane_id`, errors);
      if (typeof contribution?.weight !== "number" || !Number.isFinite(contribution.weight) || contribution.weight <= 0) {
        errors.push(`${path}.contributions[${index}].weight must be a finite number > 0`);
      }
    });
  }
  if (typeof value?.sensitivity?.winner_changes !== "boolean") {
    errors.push(`${path}.sensitivity.winner_changes must be a boolean`);
  }
  requireText(value?.sensitivity?.range, `${path}.sensitivity.range`, errors);
}

function requireStatus(value, allowed, path, errors) {
  if (!value || !allowed.has(value.status)) {
    errors.push(`${path}.status must be one of: ${[...allowed].join(", ")}`);
  }
}

function requireText(value, path, errors) {
  if (typeof value !== "string" || value.trim() === "") errors.push(`${path} must be a non-empty string`);
}

function requireOwn(value, field, path, errors) {
  if (!value || !Object.hasOwn(value, field)) errors.push(`${path} must be present (null is allowed)`);
}

function requireNonNegativeInteger(value, path, errors, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) errors.push(`${path} must be a safe integer >= ${minimum}`);
}

function requireRange(value, path, errors, minimum, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) errors.push(`${path} must be a finite number between ${minimum} and ${maximum}`);
}

async function main(path) {
  if (!path) throw new Error("Usage: node scripts/validate-decision.mjs <decision.json>");
  const document = JSON.parse(await readFile(path, "utf8"));
  const errors = validateDecision(document);
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(`Decision artifact is complete (${document.recommendations.length} recommendation(s)).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv[2]);
}
