import { RuleInferenceError } from "@hirakumi/core";
import { reloadQuietly } from "@/lib/gateway";
import { errorJson, json, readJson, type ApiRouteContext } from "@/lib/http";
import { addRequiredPhrase } from "@/lib/repo/rules";
import { loadOwnedApi } from "@/lib/route-helpers";

const LOCKED = "Your promise is published, so it can't change any more.";
const NOT_FOUND = "We couldn't find that endpoint's promise. Reload the page.";

/**
 * "Every good answer contains": a text promise gets a phrase every good answer must contain, saved as a new
 * promise version. Only before publishing (rule_built or priced): once the listing registers, its promise is public.
 */
export async function POST(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const loaded = await loadOwnedApi(req, ctx);
  if (loaded instanceof Response) return loaded;
  const { api, sql, session } = loaded;
  const body = await readJson(req);
  if (!body || typeof body.operationId !== "string" || typeof body.phrase !== "string") {
    return errorJson(400, "Type the phrase every good answer contains.");
  }
  let result;
  try {
    result = await addRequiredPhrase(sql, { apiId: api.id, sellerId: session.sellerId, operationId: body.operationId, phrase: body.phrase });
  } catch (e) {
    if (e instanceof RuleInferenceError) return errorJson(400, e.message);
    throw e;
  }
  if (!result.ok) return result.reason === "locked" ? errorJson(409, LOCKED) : errorJson(404, NOT_FOUND);
  await reloadQuietly(api.id);
  return json(result);
}
