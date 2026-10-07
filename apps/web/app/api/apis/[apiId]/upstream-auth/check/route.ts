import { checkKey } from "@/lib/gateway";
import { errorJson, json, type ApiRouteContext } from "@/lib/http";
import { getUpstreamAuth } from "@/lib/repo/upstream-auth";
import { loadOwnedApi } from "@/lib/route-helpers";

const NO_KEY = "No key is saved for this API yet.";
const RETIRED = "This API was removed from the market, so its key isn't checked.";
const UNAVAILABLE = "We couldn't check the key right now. Try again in a minute.";

/**
 * "Check key now": the gateway makes one real call to the seller's API with the saved key and answers how it
 * went (a class and the HTTP status, never the answer). Nothing is stored; the monitor stays the judge of health.
 */
export async function POST(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const loaded = await loadOwnedApi(req, ctx);
  if (loaded instanceof Response) return loaded;
  const { api, sql } = loaded;
  if (api.state === "retired") return errorJson(409, RETIRED);
  if (!(await getUpstreamAuth(sql, api.id))) return errorJson(409, NO_KEY);
  const check = await checkKey(api.id);
  if (!check) return errorJson(503, UNAVAILABLE);
  return json({ check });
}
