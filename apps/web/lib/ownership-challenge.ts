import { randomBytes } from "node:crypto";
import { buildWalletChallenge } from "@hirakumi/core";
import type { Sql } from "./db";
import { env } from "./env";
import { createWalletChallenge } from "./repo/challenges";

const WALLET_CHALLENGE_TTL_MS = 30 * 60 * 1000;

/**
 * The message the owner signs to prove ownership: names the site, the seller, the API, its origin and the address
 * buyers pay. Stored as a challenge of kind 'wallet' that finalizeOwnership consumes. Used by the ownership page and
 * the one-time ownership link (/act/<token>).
 */
export async function issueOwnershipChallenge(
  sql: Sql,
  a: { apiId: string; origin: string; sellerId: string; payTo: string },
): Promise<{ challengeId: string; message: string }> {
  const nonce = randomBytes(16).toString("hex");
  const expiresAt = new Date(Date.now() + WALLET_CHALLENGE_TTL_MS);
  const message = buildWalletChallenge({
    domain: new URL(env.webBaseUrl()).host,
    sellerId: a.sellerId,
    apiId: a.apiId,
    origin: a.origin,
    payTo: a.payTo,
    network: "cardano:preprod",
    nonce,
    expires: expiresAt.toISOString(),
  });
  const challengeId = await createWalletChallenge(sql, { apiId: a.apiId, nonce, expiresAt, message });
  return { challengeId, message };
}
