import { errorJson, json, type ApiRouteContext } from "@/lib/http";
import { issueOwnershipChallenge } from "@/lib/ownership-challenge";
import { hasFreshVerifyPass } from "@/lib/repo/challenges";
import { ownershipUpdatingResponse } from "@/lib/repo/schema";
import { loadOwnedApi, wrongStep } from "@/lib/route-helpers";

export async function POST(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const loaded = await loadOwnedApi(req, ctx);
  if (loaded instanceof Response) return loaded;
  const { api, sql, session } = loaded;
  // The verification code is a challenge of kind 'dns', which needs migration 0018.
  const updating = await ownershipUpdatingResponse(sql);
  if (updating) return updating;
  if (api.state !== "endpoints_confirmed") return wrongStep(api);
  if (!(await hasFreshVerifyPass(sql, api.id))) return errorJson(409, "Add your DNS record first. We check it on this page.");
  return json(await issueOwnershipChallenge(sql, { apiId: api.id, origin: api.origin, sellerId: session.sellerId, payTo: session.addr }));
}
