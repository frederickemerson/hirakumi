import { GatewayError, getGateway, type ChallengeCheck } from "@/lib/gateway";
import { errorJson, json, type ApiRouteContext } from "@/lib/http";
import { getOrCreateVerifyCode, markVerifyPassed } from "@/lib/repo/challenges";
import { loadOwnedApi, wrongStep } from "@/lib/route-helpers";

/**
 * Asks the gateway to request this API's base URL once and look for its code in the X-Hirakumi-Verify response
 * header (any status). The route keeps its old name: the ownership panel calls it.
 */
export async function POST(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const loaded = await loadOwnedApi(req, ctx);
  if (loaded instanceof Response) return loaded;
  const { api, sql } = loaded;
  if (api.state !== "endpoints_confirmed") return wrongStep(api);
  // Only the owning seller reaches this line (loadOwnedApi), and the code belongs to this API alone.
  const code = await getOrCreateVerifyCode(sql, api.id);
  let result: ChallengeCheck;
  try {
    result = await getGateway().checkChallenge(api.id);
  } catch (e) {
    if (e instanceof GatewayError) {
      console.error(e.message);
      return errorJson(502, e.userMessage);
    }
    throw e;
  }
  if (result.ok) await markVerifyPassed(sql, code.id, result.triedUrl);
  return json(result);
}
