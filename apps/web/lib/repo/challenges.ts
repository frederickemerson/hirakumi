import type postgres from "postgres";
import { randomBytes } from "node:crypto";
import { newId } from "@hirakumi/core";
import type { Sql } from "../db";

export const HTTP_CHALLENGE_TTL_MINUTES = 30;

export type HttpChallenge = { id: string; token: string; expiresAt: Date; passedAt: string | null };

/** Newest unconsumed, unexpired http challenge; the gateway compares against the same row (contract addition A2). */
export async function findCurrentHttpChallenge(sql: Sql, apiId: string): Promise<HttpChallenge | null> {
  const [row] = await sql<HttpChallenge[]>`
    select id, token, expires_at, proof->>'passedAt' as passed_at from challenges
    where api_id = ${apiId} and kind = 'http' and consumed_at is null and expires_at > now()
    order by expires_at desc limit 1`;
  return row ?? null;
}

export async function getOrCreateHttpChallenge(sql: Sql, apiId: string): Promise<HttpChallenge> {
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`http-challenge|${apiId}`}))`;
    const [existing] = await tx<HttpChallenge[]>`
      select id, token, expires_at, proof->>'passedAt' as passed_at from challenges
      where api_id = ${apiId} and kind = 'http' and consumed_at is null and expires_at > now()
      order by expires_at desc limit 1`;
    if (existing) return existing;
    const token = `hirakumi-verification=${apiId}.${randomBytes(24).toString("base64url")}`;
    const [created] = await tx<HttpChallenge[]>`
      insert into challenges (id, api_id, kind, token, expires_at)
      values (${newId("ch")}, ${apiId}, 'http', ${token}, now() + make_interval(mins => ${HTTP_CHALLENGE_TTL_MINUTES}))
      returning id, token, expires_at, null::text as passed_at`;
    return created;
  });
}

export async function markHttpPassed(sql: Sql, challengeId: string, triedUrl: string): Promise<void> {
  await sql`
    update challenges
    set proof = coalesce(proof, '{}'::jsonb) || ${sql.json({ passedAt: new Date().toISOString(), triedUrl } as postgres.JSONValue)}
    where id = ${challengeId}`;
}

export async function hasPassedHttpChallenge(sql: Sql, apiId: string): Promise<boolean> {
  const rows = await sql`
    select 1 from challenges
    where api_id = ${apiId} and kind = 'http' and consumed_at is null and expires_at > now()
      and proof->>'passedAt' is not null
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

/** One transaction: consume the wallet challenge, advance the state, consume the http challenge. */
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
      await tx`update challenges set consumed_at = now() where api_id = ${a.apiId} and kind = 'http' and consumed_at is null`;
      return true;
    });
  } catch (e) {
    if (e instanceof OwnershipRace) return false;
    throw e;
  }
}
