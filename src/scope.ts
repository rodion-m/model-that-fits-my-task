import type { Model } from "./types.js";
import { offerInAvailableScope } from "../.agents/skills/model-that-fits-my-task/scripts/catalog-scope.mjs";
export { hasFreshEvidence, offerInAvailableScope } from "../.agents/skills/model-that-fits-my-task/scripts/catalog-scope.mjs";

export function inAvailableScope(model: Model, generatedAt: string): boolean {
  if (model.identity_confidence === "unresolved") return false;
  return model.offers.some((offer) => offerInAvailableScope(offer, generatedAt));
}
