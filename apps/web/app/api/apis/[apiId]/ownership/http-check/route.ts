import { GatewayError, getGateway, type ChallengeCheck } from "@/lib/gateway";
import { errorJson, json, type ApiRouteContext } from "@/lib/http";
import { findCurrentHttpChallenge, markHttpPassed } from "@/lib/repo/challenges";
import { loadOwnedApi, wrongStep } from "@/lib/route-helpers";

export async function POST(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const loaded = await loadOwnedApi(req, ctx);
  if (loaded instanceof Response) return loaded;
  const { api, sql } = loaded;
  if (api.state !== "endpoints_confirmed") return wrongStep(api);
  const challenge = await findCurrentHttpChallenge(sql, api.id);
  if (!challenge) {
    return errorJson(409, "Download the verification file first. If you downloaded it more than 30 minutes ago, download it again and replace the old one.");
  }
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
  if (result.ok) await markHttpPassed(sql, challenge.id, result.triedUrl);
  return json(result);
}
