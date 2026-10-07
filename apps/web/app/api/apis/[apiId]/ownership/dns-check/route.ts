import { GatewayError, getGateway, type ChallengeCheck } from "@/lib/gateway";
import { errorJson, json, type ApiRouteContext } from "@/lib/http";
import { getOrCreateVerifyCode, markVerifyPassed } from "@/lib/repo/challenges";
import { ownershipUpdatingResponse } from "@/lib/repo/schema";
import { loadOwnedApi, wrongStep } from "@/lib/route-helpers";

/** Asks the gateway to look up the TXT record at _hirakumi.<host> for this API's code. Records the pass. */
export async function POST(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const loaded = await loadOwnedApi(req, ctx);
  if (loaded instanceof Response) return loaded;
  const { api, sql } = loaded;
  // The verification code is a challenge of kind 'dns', which needs migration 0018.
  const updating = await ownershipUpdatingResponse(sql);
  if (updating) return updating;
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
  if (result.ok) await markVerifyPassed(sql, code.id, result.record);
  return json(result);
}
