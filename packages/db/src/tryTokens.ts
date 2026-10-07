import { sha256Hex } from "@hirakumi/core";
import type postgres from "postgres";
import type { Sql } from "./client";

/** A pool or a transaction: the purchase steps below run inside withTryApiLock's transaction. */
type Q = Sql | postgres.TransactionSql;

/**
 * A live-demo pack that can still pay for calls: its credit token is active (or settling) with credits left.
 * `channelId` is set for an escrow pack (PACK_MODE=escrow); the demo wallet signs its IOUs.
 */
export type UsableTryPack = {
  id: string; token: string; creditTokenId: string; packId: string | null; txHash: string | null;
  remaining: number; pending: boolean; boughtAt: Date; channelId: string | null;
};

/**
 * Where an escrow pack is still open for calls: its lock is being verified or verified, and the demo wallet
 * never disputed an answer. A closing or settled channel takes no more calls, so a new pack is bought.
 */
export const OPEN_TRY_CHANNEL = `(t.channel_id is null or (not t.disputed and exists (
  select 1 from pack_channels p where p.channel_id = t.channel_id and p.status in ('pending', 'locked'))))`;

/**
 * Whose purchases a step looks at. The public showcase (TRY_LIVE_APIS) and a seller's free self test
 * (migration 0016) never share a pack, a recovery or a cooldown; the global limits count both.
 */
export type TryScope = { selfTestSellerId: string | null };
export const SHOWCASE: TryScope = { selfTestSellerId: null };

const scopeSql = (sql: Q, s: TryScope) =>
  s.selfTestSellerId === null ? sql`t.self_test_seller_id is null` : sql`t.self_test_seller_id = ${s.selfTestSellerId}`;

/**
 * True when the token is the public "Try it live" showcase's pack for this API (bought by the demo wallet, not a
 * seller's self test): one token shared by every visitor, whose calls the web app already limits per visitor.
 */
export async function isShowcaseTryToken(sql: Q, apiId: string, tokenHash: string): Promise<boolean> {
  const [row] = await sql`
    select 1 from try_tokens where api_id = ${apiId} and token_hash = ${tokenHash} and self_test_seller_id is null limit 1`;
  return !!row;
}

/** The newest live-demo pack for this API whose credit token still has credits (and, if escrow, is open). */
export async function findUsableTryPack(sql: Q, apiId: string, scope: TryScope = SHOWCASE): Promise<UsableTryPack | null> {
  const [row] = await sql<{
    id: string; token: string; credit_token_id: string; pack_id: string | null; tx_hash: string | null;
    remaining: number; status: string; created_at: Date; channel_id: string | null;
  }[]>`
    select t.id, t.token, c.id as credit_token_id, t.pack_id, coalesce(t.tx_hash, c.tx_hash) as tx_hash,
           c.remaining, c.status, t.created_at, t.channel_id
    from try_tokens t join credit_tokens c on c.token_hash = t.token_hash and c.api_id = t.api_id
    where t.api_id = ${apiId} and t.status = 'active' and c.status in ('active', 'pending') and c.remaining > 0
      and ${scopeSql(sql, scope)} and ${sql.unsafe(OPEN_TRY_CHANNEL)}
    order by t.created_at desc limit 1`;
  if (!row) return null;
  return {
    id: row.id, token: row.token, creditTokenId: row.credit_token_id, packId: row.pack_id, txHash: row.tx_hash,
    remaining: row.remaining, pending: row.status === "pending", boughtAt: row.created_at, channelId: row.channel_id,
  };
}

/**
 * An escrow purchase's channel and IOU key, saved once the datum was checked and the lock signed, before it
 * is sent: a lock that lands is then always closable, and its IOUs signable, whatever happens next.
 */
export async function saveTryChannel(sql: Q, id: string, r: { channelId: string; iouSecret: string; ruleHash: string }): Promise<boolean> {
  const done = await sql`
    update try_tokens set channel_id = ${r.channelId}, iou_secret = ${r.iouSecret}, rule_hash = ${r.ruleHash}
    where id = ${id} and status = 'buying'`;
  return done.count === 1;
}

export type UnsettledTryPurchase = { id: string; packId: string; paymentSignature: string; recoverySecret: string; createdAt: Date };

/** The newest purchase whose payment was signed but whose answer was lost: /recover can still re-key it. */
export async function findUnsettledTryPurchase(sql: Q, apiId: string, scope: TryScope = SHOWCASE): Promise<UnsettledTryPurchase | null> {
  const [row] = await sql<{ id: string; pack_id: string; payment_signature: string; recovery_secret: string; created_at: Date }[]>`
    select t.id, t.pack_id, t.payment_signature, t.recovery_secret, t.created_at from try_tokens t
    where t.api_id = ${apiId} and t.status = 'unsettled' and t.pack_id is not null
      and t.payment_signature is not null and t.recovery_secret is not null and ${scopeSql(sql, scope)}
    order by t.created_at desc limit 1`;
  return row
    ? { id: row.id, packId: row.pack_id, paymentSignature: row.payment_signature, recoverySecret: row.recovery_secret, createdAt: row.created_at }
    : null;
}

/** One live-demo purchase as it stands, for a caller waiting on its outcome. */
export type TryPurchase = {
  id: string; status: TryStatus; packId: string | null; paymentSignature: string | null; recoverySecret: string | null;
  txHash: string | null; credits: number | null; createdAt: Date;
};

/**
 * The purchase with this id, or with id null the newest one created within the last withinMinutes, for this API
 * and scope. Null when there is none.
 */
export async function findTryPurchase(
  sql: Q, apiId: string, scope: TryScope, id: string | null, withinMinutes: number,
): Promise<TryPurchase | null> {
  const [row] = await sql<{
    id: string; status: TryStatus; pack_id: string | null; payment_signature: string | null; recovery_secret: string | null;
    tx_hash: string | null; credits: number | null; created_at: Date;
  }[]>`
    select t.id, t.status, t.pack_id, t.payment_signature, t.recovery_secret, t.tx_hash, t.credits, t.created_at from try_tokens t
    where t.api_id = ${apiId} and ${scopeSql(sql, scope)}
      and ${id === null ? sql`t.created_at > now() - make_interval(mins => ${withinMinutes})` : sql`t.id = ${id}`}
    order by t.created_at desc limit 1`;
  return row
    ? {
      id: row.id, status: row.status, packId: row.pack_id, paymentSignature: row.payment_signature, recoverySecret: row.recovery_secret,
      txHash: row.tx_hash, credits: row.credits, createdAt: row.created_at,
    }
    : null;
}

export type TryPurchaseLimits = {
  perApiWindowSeconds: number; globalPerHour: number; globalPerDay: number;
  /** Free self tests one seller may get across all their listings (one per listing is the unique index). */
  freeTestsPerSeller?: number;
};
export type TryPurchaseSlot =
  | { ok: true }
  | { ok: false; reason: "api_cooldown" | "global_hourly" | "global_daily"; retryAfterSeconds: number }
  | { ok: false; reason: "free_test_used" | "free_test_seller_cap"; retryAfterSeconds?: undefined };

const TRY_LOCK_KEY = 727275; // serialises the limit check and the insert across gateway instances
const TRY_API_LOCK_NS = 727276; // with hashtext(api_id): one purchase sequence per API at a time

/**
 * Runs fn in one transaction holding a per-API advisory lock, so reuse, recovery and reservation for one API
 * never interleave across requests or gateway instances. The lock is released at commit or rollback, also
 * when the process dies. A waiter gives up after lockTimeoutSeconds instead of hanging.
 */
export async function withTryApiLock<T>(
  sql: Sql, apiId: string, fn: (tx: postgres.TransactionSql) => Promise<T>, lockTimeoutSeconds = 30,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe(`set local lock_timeout = '${Math.max(1, Math.floor(lockTimeoutSeconds))}s'`);
    await tx`select pg_advisory_xact_lock(${TRY_API_LOCK_NS}, hashtext(${apiId}))`;
    return fn(tx);
  }) as Promise<T>;
}

/**
 * A `buying` row older than staleMinutes belongs to a purchase that crashed. With its saved payment it becomes
 * `unsettled` (recoverable through /recover); without one nothing can be recovered, so it is `failed`
 * (it still counts toward the limits, since it may have spent).
 */
export async function expireStaleTryPurchases(sql: Q, apiId: string, staleMinutes: number): Promise<void> {
  await sql`
    update try_tokens set
      status = case when payment_signature is not null and recovery_secret is not null then 'unsettled' else 'failed' end,
      error = coalesce(error, 'stuck in buying: the purchase did not finish')
    where api_id = ${apiId} and status = 'buying' and created_at < now() - make_interval(mins => ${staleMinutes})`;
}

type ReserveInput = { id: string; apiId: string; packId: string; priceMicros: string; limits: TryPurchaseLimits; scope?: TryScope };

/**
 * Claims a purchase slot, or says which limit refuses it. Every attempt that may have spent counts: only
 * `void` rows (nothing was signed) are left out. Check and insert happen under one advisory lock, so two
 * clicks at once can never both pass. Pass a transaction to join it, or a pool to run in its own.
 */
export async function reserveTryPurchase(sql: Q, p: ReserveInput): Promise<TryPurchaseSlot> {
  if ("begin" in sql) return sql.begin((tx) => reserveIn(tx, p)) as Promise<TryPurchaseSlot>;
  return reserveIn(sql, p);
}

async function reserveIn(tx: postgres.TransactionSql, p: ReserveInput): Promise<TryPurchaseSlot> {
  await tx.unsafe(`select pg_advisory_xact_lock(${TRY_LOCK_KEY})`);
  const seller = p.scope?.selfTestSellerId ?? null;
  if (seller !== null) {
    // A free self test: once per listing (the unique index try_tokens_one_free_test backs this up) and a few per
    // seller. Both are checked under the advisory lock above, so two clicks can never both pass.
    const [used] = await tx<{ listing: boolean; seller: number }[]>`
      select exists (select 1 from try_tokens where api_id = ${p.apiId} and self_test_seller_id is not null and status <> 'void') as listing,
             (select count(*)::int from try_tokens where self_test_seller_id = ${seller} and status <> 'void') as seller`;
    if (used.listing) return { ok: false, reason: "free_test_used" };
    if (p.limits.freeTestsPerSeller !== undefined && used.seller >= p.limits.freeTestsPerSeller) return { ok: false, reason: "free_test_seller_cap" };
  }
  // The showcase cooldown is per API; a free test is once per listing, so it has none of its own.
  const [api] = seller !== null ? [{ last: null }] : await tx<{ last: Date | null }[]>`
    select max(created_at) as last from try_tokens
    where api_id = ${p.apiId} and status <> 'void' and self_test_seller_id is null
      and created_at > now() - make_interval(secs => ${p.limits.perApiWindowSeconds})`;
  if (api.last) {
    const left = p.limits.perApiWindowSeconds - Math.floor((Date.now() - api.last.getTime()) / 1000);
    return { ok: false, reason: "api_cooldown", retryAfterSeconds: Math.max(1, left) };
  }
  const windows = [
    { reason: "global_hourly" as const, seconds: 3600, max: p.limits.globalPerHour },
    { reason: "global_daily" as const, seconds: 86_400, max: p.limits.globalPerDay },
  ];
  for (const w of windows) {
    const recent = await tx<{ created_at: Date }[]>`
      select created_at from try_tokens
      where status <> 'void' and created_at > now() - make_interval(secs => ${w.seconds})
      order by created_at asc`;
    if (recent.length >= w.max) {
      // A slot frees up when the oldest attempt that still counts leaves the window.
      const oldest = recent[recent.length - w.max].created_at;
      const left = w.seconds - Math.floor((Date.now() - oldest.getTime()) / 1000);
      return { ok: false, reason: w.reason, retryAfterSeconds: Math.max(1, left) };
    }
  }
  await tx`
    insert into try_tokens (id, api_id, status, pack_id, price_micros, self_test_seller_id)
    values (${p.id}, ${p.apiId}, 'buying', ${p.packId}, ${p.priceMicros}, ${seller})`;
  return { ok: true };
}

export type TryStatus = "buying" | "active" | "unsettled" | "void" | "failed";

/** Compare-and-set: each mark changes the row only while it still has the expected status. True when it did. */
export async function markTryActive(
  sql: Q, id: string, expected: TryStatus, r: { token: string; txHash: string | null; credits: number },
): Promise<boolean> {
  const done = await sql`
    update try_tokens set status = 'active', token = ${r.token}, token_hash = ${sha256Hex(r.token)},
      tx_hash = coalesce(${r.txHash}, tx_hash), credits = ${r.credits}, settled_at = now(),
      payment_signature = null, recovery_secret = null, error = null
    where id = ${id} and status = ${expected}`;
  return done.count === 1;
}

/** Saved the moment the payment is signed, before it is sent: a crash after this stays recoverable. */
export async function saveTrySignature(sql: Q, id: string, r: { paymentSignature: string; recoverySecret: string }): Promise<boolean> {
  const done = await sql`
    update try_tokens set payment_signature = ${r.paymentSignature}, recovery_secret = ${r.recoverySecret}
    where id = ${id} and status = 'buying'`;
  return done.count === 1;
}

export async function markTryUnsettled(sql: Q, id: string, r: { paymentSignature: string; recoverySecret: string; error: string }): Promise<boolean> {
  const done = await sql`
    update try_tokens set status = 'unsettled', payment_signature = ${r.paymentSignature},
      recovery_secret = ${r.recoverySecret}, error = ${r.error.slice(0, 500)}
    where id = ${id} and status = 'buying'`;
  return done.count === 1;
}

/** void: nothing was signed, so nothing was spent and the attempt does not count toward the limits. */
export async function markTryEnded(sql: Q, id: string, expected: TryStatus, status: "void" | "failed", error: string): Promise<boolean> {
  const done = await sql`
    update try_tokens set status = ${status}, error = ${error.slice(0, 500)}, payment_signature = null, recovery_secret = null
    where id = ${id} and status = ${expected}`;
  return done.count === 1;
}
