import type { ApiRequest, ApiResponse } from "../../../src/api.js";
import { paramsFor, sendError, sendJson } from "../../../src/api.js";
import { loadSnapshot } from "../../../src/db.js";
import { getModel, QueryInputError } from "../../../src/query.js";

export default function handler(request: ApiRequest, response: ApiResponse): void {
  try {
    const params = paramsFor(request);
    const id = Array.isArray(request.query?.id) ? request.query?.id[0] : request.query?.id ?? params.get("id");
    const model = id ? getModel(loadSnapshot(), id) : undefined;
    if (!model) return sendError(response, 404, "model not found");
    sendJson(response, model);
  } catch (error) {
    if (error instanceof QueryInputError) return sendError(response, 400, error.message, error.parameter);
    sendError(response, 500, error instanceof Error ? error.message : "unable to read snapshot");
  }
}
