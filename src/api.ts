import { CACHE_TTL_SECONDS } from "./constants.js";

export interface ApiRequest {
  url?: string;
  query?: Record<string, string | string[] | undefined>;
}

export interface ApiResponse {
  status(code: number): ApiResponse;
  setHeader(name: string, value: string): ApiResponse;
  json(value: unknown): void;
  end(value?: string): void;
}

export function paramsFor(request: ApiRequest): URLSearchParams {
  const params = new URLSearchParams(request.url ? new URL(request.url, "http://localhost").search : "");
  for (const [key, value] of Object.entries(request.query ?? {})) {
    params.delete(key);
    for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) params.append(key, item);
  }
  return params;
}

export function sendJson(response: ApiResponse, body: unknown, status = 200): void {
  response.status(status);
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", status >= 400 ? "no-store" : `public, s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=86400`);
  response.json(body);
}

export function redirect(response: ApiResponse, location: string, status = 302): void {
  response.status(status);
  response.setHeader("location", location);
  response.setHeader("cache-control", `public, s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=86400`);
  response.end();
}

export function sendError(response: ApiResponse, status: number, message: string, parameter?: string): void {
  sendJson(response, { error: { status, message: status >= 500 ? "unable to serve catalog" : message, ...(parameter ? { parameter } : {}) } }, status);
}
