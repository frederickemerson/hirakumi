import type postgres from "postgres";
import type { Sql } from "../db";

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
