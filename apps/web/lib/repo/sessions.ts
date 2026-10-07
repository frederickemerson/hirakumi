import type postgres from "postgres";
import type { Sql } from "../db";
import { readSessionToken, type SessionInfo } from "../session";

const PRUNE_BATCH = 100;

/**
 * Marks a sign-in nonce used. True the first time; false when it was already used (the primary key conflicts, so
 * of many concurrent calls exactly one wins). Run it in the transaction that opens the session. Also deletes a few
 * expired rows; SKIP LOCKED keeps concurrent sign-ins from waiting on each other.
 */
export async function consumeLoginNonce(tx: postgres.TransactionSql, nonce: string, exp: number): Promise<boolean> {
  const used = await tx`
    insert into used_login_nonces (nonce, expires_at) values (${nonce}, to_timestamp(${exp}))
    on conflict (nonce) do nothing
    returning nonce`;
  await tx`
    delete from used_login_nonces where nonce in (
      select nonce from used_login_nonces where expires_at < now() limit ${PRUNE_BATCH} for update skip locked)`;
  return used.length === 1;
}

/**
 * The seller behind a session token, or null when the token is forged, expired, from before session ids, revoked
 * at logout, or its seller no longer exists. One query on two primary keys. Throws when the database can't be asked:
 * callers must refuse the request then (fail closed), never treat it as signed in.
 */
export async function liveSession(sql: Sql, token: string | null | undefined): Promise<SessionInfo | null> {
  const claims = token ? readSessionToken(token) : null;
  if (!claims) return null;
  const [row] = await sql<{ live: boolean }[]>`
    select exists (select 1 from sellers where id = ${claims.sellerId})
       and not exists (select 1 from revoked_sessions where jti = ${claims.jti}) as live`;
  return row?.live === true ? { sellerId: claims.sellerId, addr: claims.addr } : null;
}

/** Ends the session of this token for good (logout). A token that is already invalid needs nothing. */
export async function revokeSession(sql: Sql, token: string | null | undefined): Promise<void> {
  const claims = token ? readSessionToken(token) : null;
  if (!claims) return;
  await sql.begin(async (tx) => {
    // The seller may be gone (its rows went with it); then there is nothing left to revoke.
    await tx`
      insert into revoked_sessions (jti, seller_id, expires_at)
      select ${claims.jti}, id, to_timestamp(${claims.exp}) from sellers where id = ${claims.sellerId}
      on conflict (jti) do nothing`;
    await tx`
      delete from revoked_sessions where jti in (
        select jti from revoked_sessions where expires_at < now() limit ${PRUNE_BATCH} for update skip locked)`;
  });
}
