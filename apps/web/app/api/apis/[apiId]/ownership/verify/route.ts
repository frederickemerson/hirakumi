import { AddressError, toPreprodBech32, verifyCip30Signature } from "@/lib/cardano";
import { shortAddress } from "@/lib/copy";
import { errorJson, json, readJson, type ApiRouteContext } from "@/lib/http";
import { finalizeOwnership, getOpenWalletChallenge, hasFreshVerifyPass } from "@/lib/repo/challenges";
import { updatingResponse } from "@/lib/repo/schema";
import { loadOwnedApi, wrongStep } from "@/lib/route-helpers";

export async function POST(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const loaded = await loadOwnedApi(req, ctx);
  if (loaded instanceof Response) return loaded;
  const { api, sql, session } = loaded;
  // The verification code is a challenge of kind 'header', which needs migration 0015.
  const updating = await updatingResponse(sql);
  if (updating) return updating;
  if (api.state !== "endpoints_confirmed") return wrongStep(api);
  const body = await readJson(req);
  if (!body || typeof body.challengeId !== "string" || typeof body.signature !== "string" || typeof body.key !== "string") {
    return errorJson(400, "The signature was incomplete. Start the signing step again.");
  }
  if (typeof body.address === "string") {
    let signer: string;
    try {
      signer = toPreprodBech32(body.address);
    } catch (e) {
      if (e instanceof AddressError) return errorJson(400, e.message);
      throw e;
    }
    if (signer !== session.addr) {
      return errorJson(401, `You signed with a different wallet than the one you signed in with. Switch your wallet to ${shortAddress(session.addr)} and try again.`);
    }
  }
  const challenge = await getOpenWalletChallenge(sql, body.challengeId, api.id);
  if (!challenge) return errorJson(409, "This signing request expired or was already used. Start the signing step again.");
  if (!(await hasFreshVerifyPass(sql, api.id))) {
    return errorJson(409, "Check your X-Hirakumi-Verify header again. A passing check counts for 30 minutes.");
  }
  // Authoritative check: the signature must come from the seller's own payout address.
  const ok = await verifyCip30Signature(challenge.message, { signature: body.signature, key: body.key }, session.addr);
  if (!ok) return errorJson(401, "The signature didn't match this message and your wallet. Start the signing step again.");
  const done = await finalizeOwnership(sql, { apiId: api.id, walletChallengeId: challenge.id, signature: body.signature, key: body.key });
  if (!done.ok && done.reason === "base_taken") return errorJson(409, done.message);
  if (!done.ok) return errorJson(409, "This signing request expired or was already used. Start the signing step again.");
  return json({ state: "ownership_verified", warnings: done.warnings });
}
