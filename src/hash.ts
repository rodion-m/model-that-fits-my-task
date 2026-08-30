import { createHash } from "node:crypto";
import { stableValue } from "../.agents/skills/model-that-fits-my-task/scripts/benchmark-semantics.mjs";
export { stableValue } from "../.agents/skills/model-that-fits-my-task/scripts/benchmark-semantics.mjs";

export function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function contentHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}
