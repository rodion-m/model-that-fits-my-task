import { DEFAULT_LIMIT, MAX_LIMIT, WORKLOAD_PROFILES } from "./constants.js";
import type { WorkloadProfile } from "./types.js";
import { validateWorkload } from "./cost.js";

export type QueryScope = "available" | "all";

export class QueryInputError extends Error {
  parameter: string;
  constructor(parameter: string, message: string) {
    super(message);
    this.parameter = parameter;
  }
}

export interface ParsedPaging {
  limit: number;
  offset: number;
}

export function getter(params: URLSearchParams | Record<string, string | undefined>): (key: string) => string | undefined {
  return (key: string) => params instanceof URLSearchParams ? params.get(key) ?? undefined : params[key];
}

export function valuesFor(params: URLSearchParams | Record<string, string | undefined>, key: string): string[] {
  const raw = params instanceof URLSearchParams ? params.getAll(key) : [params[key]];
  return [...new Set(raw.flatMap((value) => value?.split(",") ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

export function parseScope(value: string | undefined): QueryScope {
  if (value === undefined || value === "") return "available";
  if (value === "available" || value === "all") return value;
  throw new QueryInputError("scope", "scope must be available or all");
}

export function parseView(value: string | undefined): "summary" | "full" {
  if (value === undefined || value === "" || value === "full") return "full";
  if (value === "summary") return "summary";
  throw new QueryInputError("view", "view must be summary or full");
}

export function parseBoolean(value: string | undefined, parameter: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new QueryInputError(parameter, `${parameter} must be true, false, 1, or 0`);
}

export function parseNonNegative(value: string | undefined, parameter: string): number | undefined {
  if (value === undefined) return undefined;
  const result = Number(value);
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) || !Number.isFinite(result) || result < 0) throw new QueryInputError(parameter, `${parameter} must be a non-negative decimal number`);
  return result;
}

export function parseInteger(value: string | undefined, parameter: string): number | undefined {
  if (value === undefined) return undefined;
  const result = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(result)) throw new QueryInputError(parameter, `${parameter} must be a non-negative safe decimal integer`);
  return result;
}

export function parseDate(value: string | undefined, parameter: string): string | undefined {
  if (value === undefined) return undefined;
  const date = value.slice(0, 10);
  const parsedDate = Date.parse(`${date}T00:00:00.000Z`);
  const exactCalendarDate = Number.isFinite(parsedDate) && new Date(parsedDate).toISOString().slice(0, 10) === date;
  if (!/^\d{4}-\d{2}-\d{2}(?:[Tt ].*)?$/.test(value) || !exactCalendarDate || !Number.isFinite(Date.parse(value))) {
    throw new QueryInputError(parameter, `${parameter} must be an ISO date`);
  }
  return date;
}

export function parseEnum(value: string | undefined, parameter: string, allowed: readonly string[]): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!allowed.includes(value)) throw new QueryInputError(parameter, `${parameter} must be one of: ${allowed.join(", ")}`);
  return value;
}

export function parsePaging(rawLimit: string | undefined, rawOffset: string | undefined, maxLimit = MAX_LIMIT): ParsedPaging {
  const limit = Math.min(maxLimit, Math.max(1, parseInteger(rawLimit, "limit") ?? DEFAULT_LIMIT));
  const offset = parseInteger(rawOffset, "offset") ?? 0;
  return { limit, offset };
}

export function parseModelSort(value: string | undefined): "name" | "context" | "updated" | "released" {
  const sort = parseEnum(value, "sort", ["name", "context", "updated", "released"]);
  return (sort as "name" | "context" | "updated" | "released" | undefined) ?? "name";
}

export function parseOfferSort(value: string | undefined): "default" | "context" | "cost" {
  const sort = parseEnum(value, "sort", ["context", "cost"]);
  return (sort as "context" | "cost" | undefined) ?? "default";
}

export function parseObservationSort(value: string | undefined): "default" | "score" {
  const sort = parseEnum(value, "sort", ["score"]);
  return (sort as "score" | undefined) ?? "default";
}

export function resolveWorkloadProfile(get: (key: string) => string | undefined): WorkloadProfile | undefined {
  const profileId = get("profile");
  const customKeys = ["input_tokens", "output_tokens", "cached_input_ratio", "requests_per_task"];
  const overlay = readCostOverlays(get);
  const hasCustomValues = customKeys.some((key) => get(key) !== undefined);
  if (!profileId) {
    if (hasCustomValues) throw new QueryInputError("profile", "custom workload parameters require profile=custom");
    if (overlay.cache_write_tokens !== undefined || overlay.reasoning_tokens !== undefined) {
      throw new QueryInputError("profile", "cache_write_tokens and reasoning_tokens require a workload profile");
    }
    return undefined;
  }
  if (profileId !== "custom") {
    if (hasCustomValues) throw new QueryInputError("profile", "custom workload parameters can only be used with profile=custom");
    const profile = WORKLOAD_PROFILES.find((value) => value.id === profileId);
    if (!profile) throw new QueryInputError("profile", `unknown workload profile: ${profileId}`);
    return checkedWorkload({ ...profile, ...overlay });
  }

  const inputTokens = requiredNonNegativeInteger(get("input_tokens"), "input_tokens");
  const outputTokens = requiredNonNegativeInteger(get("output_tokens"), "output_tokens");
  const cachedInputRatio = optionalNumber(get("cached_input_ratio"), 0, "cached_input_ratio");
  if (cachedInputRatio < 0 || cachedInputRatio > 1) throw new QueryInputError("cached_input_ratio", "cached_input_ratio must be between 0 and 1");
  const requestsPerTask = optionalInteger(get("requests_per_task"), 1, "requests_per_task");
  if (requestsPerTask < 1) throw new QueryInputError("requests_per_task", "requests_per_task must be a positive integer");
  return checkedWorkload({
    id: "custom",
    description: "Caller-supplied workload profile.",
    input_tokens: inputTokens,
    cached_input_ratio: cachedInputRatio,
    output_tokens: outputTokens,
    requests_per_task: requestsPerTask,
    ...overlay,
  });
}

function checkedWorkload(profile: WorkloadProfile): WorkloadProfile {
  try { validateWorkload(profile); }
  catch (error) { throw new QueryInputError("profile", error instanceof Error ? error.message : "invalid workload profile"); }
  return profile;
}

function readCostOverlays(get: (key: string) => string | undefined): Pick<WorkloadProfile, "cache_write_tokens" | "reasoning_tokens"> {
  const cacheWrite = parseInteger(get("cache_write_tokens"), "cache_write_tokens");
  const reasoning = parseInteger(get("reasoning_tokens"), "reasoning_tokens");
  return {
    ...(cacheWrite !== undefined ? { cache_write_tokens: cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoning_tokens: reasoning } : {}),
  };
}

function requiredNonNegativeInteger(value: string | undefined, name: string): number {
  if (value === undefined || value.trim() === "") throw new QueryInputError(name, `${name} is required for profile=custom`);
  return parseInteger(value, name)!;
}

function optionalInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  return parseInteger(value, name)!;
}

function optionalNumber(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  return parseNonNegative(value, name)!;
}
