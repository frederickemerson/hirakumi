import type postgres from "postgres";
import { newId, newVerifyCode } from "@hirakumi/core";
import type { Sql } from "../db";

/** A passing OpenAPI check counts for this long; after that the seller checks again before signing. */
export const VERIFY_PASS_TTL_MINUTES = 30;

/** The API's verification code (challenges.kind = 'openapi'). It stays the same until ownership is proven. */
export type VerifyCode = { id: string; code: string; passedAt: string | null };

/** This API's open code, or null. At most one exists per API (unique index, migration 0009). */
export async function findVerifyCode(sql: Sql, apiId: string): Promise<VerifyCode | null> {
  const [row] = await sql<VerifyCode[]>`
    select id, token as code, proof->>'passedAt' as passed_at from challenges
    where api_id = ${apiId} and kind = 'openapi' and consumed_at is null
    limit 1`;
  return row ?? null;
}

/** The code is per API: 256 random bits, never reused (unique index), only shown to the owning seller (callers check). */
export async function getOrCreateVerifyCode(sql: Sql, apiId: string): Promise<VerifyCode> {
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`openapi-verify|${apiId}`}))`;
    const [existing] = await tx<VerifyCode[]>`
      select id, token as code, proof->>'passedAt' as passed_at from challenges
      where api_id = ${apiId} and kind = 'openapi' and consumed_at is null
      limit 1`;
    if (existing) return existing;
    // expires_at is required by the table; the code itself only ends when ownership is finalised.
    const [created] = await tx<VerifyCode[]>`
      insert into challenges (id, api_id, kind, token, expires_at)
      values (${newId("ch")}, ${apiId}, 'openapi', ${newVerifyCode()}, now() + interval '10 years')
      returning id, token as code, null::text as passed_at`;
    return created;
  });
}

export async function markVerifyPassed(sql: Sql, challengeId: string, triedUrl: string): Promise<void> {
  await sql`
    update challenges
    set proof = coalesce(proof, '{}'::jsonb) || ${sql.json({ passedAt: new Date().toISOString(), triedUrl } as postgres.JSONValue)}
    where id = ${challengeId} and kind = 'openapi' and consumed_at is null`;
}

/** True when this API's own code passed the OpenAPI check in the last VERIFY_PASS_TTL_MINUTES. */
export async function hasFreshVerifyPass(sql: Sql, apiId: string): Promise<boolean> {
  const rows = await sql`
    select 1 from challenges
    where api_id = ${apiId} and kind = 'openapi' and consumed_at is null
      and (proof->>'passedAt')::timestamptz > now() - make_interval(mins => ${VERIFY_PASS_TTL_MINUTES})
    limit 1`;
  return rows.length > 0;
}

export async function createWalletChallenge(
  sql: Sql,
  a: { apiId: string; nonce: string; expiresAt: Date; message: string },
): Promise<string> {
  const id = newId("ch");
  await sql`
    insert into challenges (id, api_id, kind, token, expires_at, proof)
    values (${id}, ${a.apiId}, 'wallet', ${a.nonce}, ${a.expiresAt}, ${sql.json({ message: a.message } as postgres.JSONValue)})`;
  return id;
}

export async function getOpenWalletChallenge(sql: Sql, challengeId: string, apiId: string): Promise<{ id: string; message: string } | null> {
  const [row] = await sql<{ id: string; message: string | null }[]>`
    select id, proof->>'message' as message from challenges
    where id = ${challengeId} and api_id = ${apiId} and kind = 'wallet' and consumed_at is null and expires_at > now()`;
  return row && row.message ? { id: row.id, message: row.message } : null;
}

class OwnershipRace extends Error {}

/** One transaction: consume the wallet challenge, advance the state, consume the verification code. */
export async function finalizeOwnership(
  sql: Sql,
  a: { apiId: string; walletChallengeId: string; signature: string; key: string },
): Promise<boolean> {
  try {
    return await sql.begin(async (tx) => {
      const consumed = await tx`
        update challenges
        set consumed_at = now(),
            proof = coalesce(proof, '{}'::jsonb) || ${sql.json({ signature: a.signature, key: a.key, verifiedAt: new Date().toISOString() } as postgres.JSONValue)}
        where id = ${a.walletChallengeId} and api_id = ${a.apiId} and kind = 'wallet' and consumed_at is null and expires_at > now()
        returning id`;
      if (consumed.length !== 1) throw new OwnershipRace();
      const moved = await tx`
        update apis set state = 'ownership_verified' where id = ${a.apiId} and state = 'endpoints_confirmed' returning id`;
      if (moved.length !== 1) throw new OwnershipRace();
      await tx`update challenges set consumed_at = now() where api_id = ${a.apiId} and kind in ('openapi', 'http') and consumed_at is null`;
      return true;
    });
  } catch (e) {
    if (e instanceof OwnershipRace) return false;
    throw e;
  }
}
