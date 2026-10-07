import { ACT_DONE, actLines, openAct, wrongWallet, type ActRouteContext, type OpenedAct } from "@/lib/act";
import { verifyCip30Signature } from "@/lib/cardano";
import { getSql, type Sql } from "@/lib/db";
import { errorJson, json, readJson, sameOrigin } from "@/lib/http";
import { publishApi } from "@/lib/publish";
import { tellTask, useActToken } from "@/lib/repo/act-tokens";
import { finalizeOwnership, getOpenWalletChallenge, hasFreshVerifyPass } from "@/lib/repo/challenges";
import { ownershipUpdatingResponse } from "@/lib/repo/schema";
import { consumeLoginNonce } from "@/lib/repo/sessions";
import { openActChallenge } from "@/lib/session";
import { saveUpstreamKey } from "@/lib/upstream-key-save";

const STALE = "This signing request expired or was already used. Sign again.";
const OTHER_STEP = "This signature is for a different link. Open the link from your Sokosumi task and sign again.";
const BAD_SIGNATURE = "The signature didn't match this message and your wallet. Sign again.";

type Sig = { signature: string; key: string };

/**
 * One signed action on a one-time link (/act/<token>). The signature must come from the API owner's wallet and be
 * over the message issued for this link (challenge route). The link is used up only when the action succeeds, so a
 * refused key or a DNS record that went missing can be fixed and signed again on the same link while it is valid.
 * Body: address, signature, key, then challengeId (ownership) or nonceToken (key, publish), and the optional
 * upstreamAuth (the API's key, saved exactly as the key form saves it) with saveAnyway.
 */
export async function POST(req: Request, ctx: ActRouteContext): Promise<Response> {
  if (!sameOrigin(req)) return errorJson(403, "Cross-site request refused.");
  const body = await readJson(req);
  if (!body || typeof body.signature !== "string" || typeof body.key !== "string") {
    return errorJson(400, "The signature was incomplete. Sign again.");
  }
  const sql = getSql();
  const opened = await openAct(sql, (await ctx.params).token);
  if (!opened.ok) return errorJson(opened.status, opened.error);
  const wrong = wrongWallet(opened, body.address);
  if (wrong) return errorJson(wrong.status, wrong.error);
  const sig = { signature: body.signature, key: body.key };
  const upstreamAuth = body.upstreamAuth && typeof body.upstreamAuth === "object" && !Array.isArray(body.upstreamAuth)
    ? { ...(body.upstreamAuth as Record<string, unknown>), saveAnyway: body.saveAnyway === true }
    : null;
  if (opened.act.action === "ownership") return proveOwnership(sql, opened, body.challengeId, sig, upstreamAuth);

  if (typeof body.nonceToken !== "string") return errorJson(400, OTHER_STEP);
  const challenge = openActChallenge(body.nonceToken);
  if (!challenge) return errorJson(401, STALE);
  if (challenge.actId !== opened.act.id || challenge.addr !== opened.owner.addr) return errorJson(400, OTHER_STEP);
  // What was signed must still be what happens: a price changed after the message was issued is signed again.
  if (JSON.stringify(challenge.lines) !== JSON.stringify(await actLines(sql, opened))) {
    return errorJson(409, "Something changed since you signed (such as the price). Sign again.");
  }
  if (!(await verifyCip30Signature(challenge.message, sig, opened.owner.addr))) return errorJson(401, BAD_SIGNATURE);
  // The signed message is used once, like a sign-in (same table): a replay of it does nothing.
  if (!(await sql.begin((tx) => consumeLoginNonce(tx, challenge.nonce, challenge.exp)))) return errorJson(401, STALE);

  if (opened.act.action === "key") {
    if (!upstreamAuth) return errorJson(400, "Type your API's key, then sign.");
    const saved = await saveUpstreamKey(sql, opened.api, opened.owner.sellerId, upstreamAuth);
    if (!saved.ok) return saved;
    await useActToken(sql, opened.act.id);
    await tellTask(sql, opened.api.id, "Your API's key is saved, sealed so only the Hirakumi gateway can read it.", `act_done:${opened.act.id}`);
    return json({ done: true, message: ACT_DONE });
  }
  const published = await publishApi(sql, opened.api, opened.owner.sellerId);
  if (!published.ok) return published;
  await useActToken(sql, opened.act.id);
  return json({ done: true, message: ACT_DONE });
}

/** The ownership page's verify step (ownership/verify route), with the owner taken from the API, not a session. */
async function proveOwnership(sql: Sql, opened: OpenedAct, challengeId: unknown, sig: Sig, upstreamAuth: Record<string, unknown> | null): Promise<Response> {
  if (typeof challengeId !== "string") return errorJson(400, OTHER_STEP);
  const updating = await ownershipUpdatingResponse(sql);
  if (updating) return updating;
  const challenge = await getOpenWalletChallenge(sql, challengeId, opened.api.id);
  if (!challenge) return errorJson(409, STALE);
  if (!(await hasFreshVerifyPass(sql, opened.api.id))) {
    return errorJson(409, "Your DNS record was last found over 30 minutes ago. Sign again: the page looks it up first.");
  }
  if (!(await verifyCip30Signature(challenge.message, sig, opened.owner.addr))) return errorJson(401, BAD_SIGNATURE);
  // The key goes in before ownership is final, so the test calls that start right after already use it.
  if (upstreamAuth) {
    const saved = await saveUpstreamKey(sql, opened.api, opened.owner.sellerId, upstreamAuth);
    if (!saved.ok) return saved;
  }
  const done = await finalizeOwnership(sql, { apiId: opened.api.id, walletChallengeId: challenge.id, ...sig });
  if (!done.ok && done.reason === "base_taken") return errorJson(409, done.message);
  if (!done.ok) return errorJson(409, STALE);
  await useActToken(sql, opened.act.id);
  return json({ done: true, message: ACT_DONE, warnings: done.warnings });
}
