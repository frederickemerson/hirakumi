import { sha256Hex } from "@hirakumi/core";
import type { Sql } from "./client";

/** A live-demo pack that can still pay for calls: its credit token is active (or settling) with credits left. */
export type UsableTryPack = {
  id: string; token: string; creditTokenId: string; packId: string | null; txHash: string | null;
  remaining: number; pending: boolean; boughtAt: Date;
};

/** The newest live-demo pack for this API whose credit token still has credits. */
export async function findUsableTryPack(sql: Sql, apiId: string): Promise<UsableTryPack | null> {
  const [row] = await sql<{
    id: string; token: string; credit_token_id: string; pack_id: string | null; tx_hash: string | null;
    remaining: number; status: string; created_at: Date;
  }[]>`
    select t.id, t.token, c.id as credit_token_id, t.pack_id, coalesce(t.tx_hash, c.tx_hash) as tx_hash,
           c.remaining, c.status, t.created_at
    from try_tokens t join credit_tokens c on c.token_hash = t.token_hash and c.api_id = t.api_id
    where t.api_id = ${apiId} and t.status = 'active' and c.status in ('active', 'pending') and c.remaining > 0
    order by t.created_at desc limit 1`;
  if (!row) return null;
  return {
    id: row.id, token: row.token, creditTokenId: row.credit_token_id, packId: row.pack_id, txHash: row.tx_hash,
    remaining: row.remaining, pending: row.status === "pending", boughtAt: row.created_at,
  };
}

export type UnsettledTryPurchase = { id: string; packId: string; paymentSignature: string; recoverySecret: string; createdAt: Date };

/** The newest purchase whose payment was signed but whose answer was lost: /recover can still re-key it. */
export async function findUnsettledTryPurchase(sql: Sql, apiId: string): Promise<UnsettledTryPurchase | null> {
  const [row] = await sql<{ id: string; pack_id: string; payment_signature: string; recovery_secret: string; created_at: Date }[]>`
    select id, pack_id, payment_signature, recovery_secret, created_at from try_tokens
    where api_id = ${apiId} and status = 'unsettled' and pack_id is not null
      and payment_signature is not null and recovery_secret is not null
    order by created_at desc limit 1`;
  return row
    ? { id: row.id, packId: row.pack_id, paymentSignature: row.payment_signature, recoverySecret: row.recovery_secret, createdAt: row.created_at }
    : null;
}

export type TryPurchaseLimits = { perApiWindowSeconds: number; globalPerHour: number };
export type TryPurchaseSlot =
  | { ok: true }
  | { ok: false; reason: "api_cooldown" | "global_hourly"; retryAfterSeconds: number };

const TRY_LOCK_KEY = 727275; // serialises the limit check and the insert across gateway instances

/**
 * Claims a purchase slot, or says which limit refuses it. Every attempt that may have spent counts: only
 * `void` rows (nothing was signed) are left out. Check and insert happen under one advisory lock, so two
 * clicks at once can never both pass.
 */
export async function reserveTryPurchase(
  sql: Sql,
  p: { id: string; apiId: string; packId: string; priceMicros: string; limits: TryPurchaseLimits },
): Promise<TryPurchaseSlot> {
  return sql.begin(async (tx) => {
    await tx.unsafe(`select pg_advisory_xact_lock(${TRY_LOCK_KEY})`);
    const [api] = await tx<{ last: Date | null }[]>`
      select max(created_at) as last from try_tokens
      where api_id = ${p.apiId} and status <> 'void' and created_at > now() - make_interval(secs => ${p.limits.perApiWindowSeconds})`;
    if (api.last) {
      const left = p.limits.perApiWindowSeconds - Math.floor((Date.now() - api.last.getTime()) / 1000);
      return { ok: false as const, reason: "api_cooldown" as const, retryAfterSeconds: Math.max(1, left) };
    }
    const recent = await tx<{ created_at: Date }[]>`
      select created_at from try_tokens
      where status <> 'void' and created_at > now() - interval '1 hour'
      order by created_at asc`;
    if (recent.length >= p.limits.globalPerHour) {
      // A slot frees up when the oldest attempt that still counts leaves the hour.
      const oldest = recent[recent.length - p.limits.globalPerHour].created_at;
      const left = 3600 - Math.floor((Date.now() - oldest.getTime()) / 1000);
      return { ok: false as const, reason: "global_hourly" as const, retryAfterSeconds: Math.max(1, left) };
    }
    await tx`
      insert into try_tokens (id, api_id, status, pack_id, price_micros)
      values (${p.id}, ${p.apiId}, 'buying', ${p.packId}, ${p.priceMicros})`;
    return { ok: true as const };
  });
}

export async function markTryActive(sql: Sql, id: string, r: { token: string; txHash: string | null; credits: number }): Promise<void> {
  await sql`
    update try_tokens set status = 'active', token = ${r.token}, token_hash = ${sha256Hex(r.token)},
      tx_hash = coalesce(${r.txHash}, tx_hash), credits = ${r.credits}, settled_at = now(),
      payment_signature = null, recovery_secret = null, error = null
    where id = ${id}`;
}

export async function markTryUnsettled(sql: Sql, id: string, r: { paymentSignature: string; recoverySecret: string; error: string }): Promise<void> {
  await sql`
    update try_tokens set status = 'unsettled', payment_signature = ${r.paymentSignature},
      recovery_secret = ${r.recoverySecret}, error = ${r.error.slice(0, 500)}
    where id = ${id}`;
}

/** void: nothing was signed, so nothing was spent and the attempt does not count toward the limits. */
export async function markTryEnded(sql: Sql, id: string, status: "void" | "failed", error: string): Promise<void> {
  await sql`
    update try_tokens set status = ${status}, error = ${error.slice(0, 500)}, payment_signature = null, recovery_secret = null
    where id = ${id}`;
}
