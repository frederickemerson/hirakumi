import { randomBytes } from "node:crypto";
import { buildWalletChallenge } from "@hirakumi/core";
import { env } from "@/lib/env";
import { errorJson, json, type ApiRouteContext } from "@/lib/http";
import { createWalletChallenge, hasFreshVerifyPass } from "@/lib/repo/challenges";
import { updatingResponse } from "@/lib/repo/schema";
import { loadOwnedApi, wrongStep } from "@/lib/route-helpers";

const WALLET_CHALLENGE_TTL_MS = 30 * 60 * 1000;

export async function POST(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const loaded = await loadOwnedApi(req, ctx);
  if (loaded instanceof Response) return loaded;
  const { api, sql, session } = loaded;
  // The verification code is a challenge of kind 'header', which needs migration 0015.
  const updating = await updatingResponse(sql);
  if (updating) return updating;
  if (api.state !== "endpoints_confirmed") return wrongStep(api);
  if (!(await hasFreshVerifyPass(sql, api.id))) return errorJson(409, "Check your X-Hirakumi-Verify header first.");
  const nonce = randomBytes(16).toString("hex");
  const expiresAt = new Date(Date.now() + WALLET_CHALLENGE_TTL_MS);
  const message = buildWalletChallenge({
    domain: new URL(env.webBaseUrl()).host,
    sellerId: session.sellerId,
    apiId: api.id,
    origin: api.origin,
    payTo: session.addr,
    network: "cardano:preprod",
    nonce,
    expires: expiresAt.toISOString(),
  });
  const challengeId = await createWalletChallenge(sql, { apiId: api.id, nonce, expiresAt, message });
  return json({ challengeId, message });
}
