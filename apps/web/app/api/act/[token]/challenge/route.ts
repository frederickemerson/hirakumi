import { actLines, openAct, wrongWallet, type ActRouteContext } from "@/lib/act";
import { getSql } from "@/lib/db";
import { GatewayError, getGateway } from "@/lib/gateway";
import { errorJson, json, readJson, sameOrigin } from "@/lib/http";
import { issueOwnershipChallenge } from "@/lib/ownership-challenge";
import { getOrCreateVerifyCode, hasFreshVerifyPass, markVerifyPassed } from "@/lib/repo/challenges";
import { ownershipUpdatingResponse } from "@/lib/repo/schema";
import { issueActChallenge } from "@/lib/session";

/**
 * The message the API owner signs on a one-time link (/act/<token>). Only for the owner's wallet: another wallet is
 * refused before anything is issued. Ownership: the same wallet challenge as the ownership page, once the DNS record
 * passed in the last 30 minutes (looked up again here if the coworker's pass is older). Key and publish: a sealed
 * one-time message naming the action and this link.
 */
export async function POST(req: Request, ctx: ActRouteContext): Promise<Response> {
  if (!sameOrigin(req)) return errorJson(403, "Cross-site request refused.");
  const body = await readJson(req);
  if (!body || typeof body.address !== "string") return errorJson(400, "Connect a wallet first.");
  const sql = getSql();
  const opened = await openAct(sql, (await ctx.params).token);
  if (!opened.ok) return errorJson(opened.status, opened.error);
  const wrong = wrongWallet(opened, body.address);
  if (wrong) return errorJson(wrong.status, wrong.error);
  const { act, api, owner } = opened;
  if (act.action !== "ownership") {
    const { message, nonceToken } = issueActChallenge(owner.addr, act.id, await actLines(sql, opened));
    return json({ kind: "act", message, nonceToken });
  }
  const updating = await ownershipUpdatingResponse(sql);
  if (updating) return updating;
  if (!(await hasFreshVerifyPass(sql, api.id))) {
    // The same check and record of the pass as the ownership page (dns-check route).
    const code = await getOrCreateVerifyCode(sql, api.id);
    let result;
    try {
      result = await getGateway().checkChallenge(api.id);
    } catch (e) {
      if (e instanceof GatewayError) {
        console.error(e.message);
        return errorJson(502, e.userMessage);
      }
      throw e;
    }
    if (!result.ok) {
      return errorJson(409, `We can't find your DNS record at ${result.record} right now. Keep it in place, wait a minute, then sign again.`);
    }
    await markVerifyPassed(sql, code.id, result.record);
  }
  const challenge = await issueOwnershipChallenge(sql, { apiId: api.id, origin: api.origin, sellerId: owner.sellerId, payTo: owner.addr });
  return json({ kind: "wallet", ...challenge });
}
