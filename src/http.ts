import type { FetchOptions } from "./types.js";
import { DEFAULT_MAX_BYTES } from "./constants.js";

export class FetchError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "FetchError";
  }
}

async function readBody(response: Response, url: string, maxBytes: number): Promise<string> {
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > maxBytes) {
    await response.body?.cancel();
    throw new FetchError(`response exceeds ${maxBytes} bytes`, url, response.status);
  }
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new FetchError(`response exceeds ${maxBytes} bytes`, url, response.status);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function retryDelay(response: Response): number {
  const value = response.headers.get("retry-after");
  if (!value) return 500;
  const seconds = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : (Date.parse(value) - Date.now()) / 1_000;
  return Number.isFinite(seconds) ? Math.max(100, seconds * 1_000) : 500;
}

export async function fetchJson<T = any>(url: string, options: FetchOptions = {}): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const retries = options.retries ?? 1;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers: { accept: "application/json", ...(options.headers ?? {}) },
        signal: controller.signal,
      });
      if (response.status === 429 && attempt < retries) {
        const delay = retryDelay(response);
        await response.body?.cancel();
        if (delay > 2_000) throw new FetchError("HTTP 429: Retry-After exceeds the bounded retry window", url, 429);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      if (!response.ok) throw new FetchError(`HTTP ${response.status}`, url, response.status);
      const text = await readBody(response, url, maxBytes);
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new FetchError("invalid JSON response", url, response.status);
      }
    } catch (error) {
      if (error instanceof FetchError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new FetchError(message, url);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new FetchError("request failed", url);
}

export async function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { headers: options.headers, signal: controller.signal });
    if (!response.ok) throw new FetchError(`HTTP ${response.status}`, url, response.status);
    return await readBody(response, url, maxBytes);
  } catch (error) {
    if (error instanceof FetchError) throw error;
    throw new FetchError(error instanceof Error ? error.message : String(error), url);
  } finally {
    clearTimeout(timer);
  }
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("concurrency must be a positive integer");
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, worker));
  return results;
}
