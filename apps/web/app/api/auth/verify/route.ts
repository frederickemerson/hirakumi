import { verifyCip30Signature } from "@/lib/cardano";
import { getSql } from "@/lib/db";
import { errorJson, json, readJson } from "@/lib/http";
import { upsertSeller } from "@/lib/repo/sellers";
import { consumeLoginNonce } from "@/lib/repo/sessions";
import { createSessionToken, openLoginChallenge, sessionCookieHeader } from "@/lib/session";

export async function POST(req: Request): Promise<Response> {
  const body = await readJson(req);
  if (!body || typeof body.nonceToken !== "string" || typeof body.signature !== "string" || typeof body.key !== "string") {
    return errorJson(400, "The sign-in request was incomplete. Try again.");
  }
  const challenge = openLoginChallenge(body.nonceToken);
  if (!challenge) return errorJson(401, "This sign-in request expired. Start again.");
  const ok = await verifyCip30Signature(challenge.message, { signature: body.signature, key: body.key }, challenge.addr);
  if (!ok) {
    return errorJson(401, "The wallet signature didn't match. Make sure you signed with the same wallet account you connected.");
  }
  // The nonce is used up only by a valid signature, and in the transaction that creates the seller: a replay of the
  // same signed message, even a concurrent one, conflicts on the nonce and opens no session.
  const seller = await getSql().begin(async (tx) =>
    (await consumeLoginNonce(tx, challenge.nonce, challenge.exp)) ? upsertSeller(tx, challenge.addr) : null);
  if (!seller) return errorJson(401, "This sign-in link was already used. Start again.");
  return json(
    { sellerId: seller.id, address: seller.cardanoAddr },
    200,
    { "set-cookie": sessionCookieHeader(createSessionToken(seller.id, seller.cardanoAddr)) },
  );
}
