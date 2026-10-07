import { ruleHash, sha256Hex, type RuleDefinition } from "@hirakumi/core";
import type { Sql } from "./db";
import { hasSelfTestSchema } from "./repo/self-test-schema";
import type { TryChannel, TryEscrowStore } from "./try-escrow";

export type TryOperationRow = {
  opId: string;
  method: string;
  path: string;
  description: string | null;
  inputSchema: { properties?: Record<string, Record<string, unknown>>; required?: string[] };
};

/** Enabled endpoints of a live API with their input schemas, for the public try page. */
export async function listTryOperations(sql: Sql, apiId: string): Promise<TryOperationRow[]> {
  return sql<TryOperationRow[]>`
    select o.op_id, o.method, o.path, o.description, o.input_schema
    from operations o join apis a on a.id = o.api_id
    where o.api_id = ${apiId} and o.enabled and a.state = 'live'
    order by o.path, o.method`;
}

/**
 * The pack "Try it live" pays with. `live`: bought for real by the gateway's demo wallet (try_tokens).
 * `env`: the older hand-bought token in TRY_CREDIT_TOKENS. The token never leaves the server.
 */
export type TryPack = {
  token: string;
  creditTokenId: string;
  remaining: number;
  /** The payment has not settled yet: calls answer token_pending until it does. */
  pending: boolean;
  txHash: string | null;
  boughtAt: Date;
  /** `wallet`: a seller bought it for their own API with their own wallet (self_test_packs). */
  source: "live" | "env" | "wallet";
  /** An escrow pack (PACK_MODE=escrow): the demo wallet signs its IOUs (lib/try-escrow). Null for a direct pack. */
  channel?: TryChannel | null;
};

/** Columns arrive camel-cased (lib/db transform). */
export type PackRow = {
  token: string; creditTokenId: string; remaining: number; status: string; txHash: string | null; boughtAt: Date;
  tryId?: string; channelId?: string | null; iouSecret?: string | null; ruleHash?: string | null; iouLast?: string | null;
};

export const toPack = (r: PackRow, source: TryPack["source"]): TryPack => ({
  token: r.token, creditTokenId: r.creditTokenId, remaining: r.remaining, pending: r.status === "pending",
  txHash: r.txHash, boughtAt: r.boughtAt, source,
  channel: r.tryId && r.channelId && r.iouSecret && r.ruleHash
    ? { tryId: r.tryId, channelId: r.channelId, secretKey: r.iouSecret, ruleHash: r.ruleHash, lastIou: r.iouLast ?? null }
    : null,
});

/**
 * The newest public pack for this API, live purchases first, then the TRY_CREDIT_TOKENS fallback. A seller's own
 * free test (self_test_seller_id) is never public: it powers only that seller's Try it live (lib/self-test-repo). With
 * `withCredits` (the default) only a pack that can still pay is returned; without it, the newest one at all
 * (its receipts stay readable after the credits run out).
 */
export async function findTryPack(
  sql: Sql,
  apiId: string,
  envToken: string | undefined,
  opts: { withCredits?: boolean } = {},
): Promise<TryPack | null> {
  // Postgres text can't hold a NUL byte, so no row has such an id; asking would fail the query (a 500).
  if (apiId.includes("\u0000")) return null;
  const withCredits = opts.withCredits ?? true;
  // An escrow pack can pay only while its channel takes calls (lock pending or verified, never disputed); the
  // same rule as the gateway's findUsableTryPack (packages/db/src/tryTokens.ts, OPEN_TRY_CHANNEL).
  const [live] = await sql<PackRow[]>`
    select t.token, c.id as credit_token_id, c.remaining, c.status, coalesce(t.tx_hash, c.tx_hash) as tx_hash, t.created_at as bought_at,
           t.id as try_id, t.channel_id, t.iou_secret, t.rule_hash, t.iou_last
    from try_tokens t join credit_tokens c on c.token_hash = t.token_hash and c.api_id = t.api_id
    where t.api_id = ${apiId} and t.status = 'active' ${(await hasSelfTestSchema(sql)) ? sql`and t.self_test_seller_id is null` : sql``}
      and (${!withCredits} or (c.status in ('active', 'pending') and c.remaining > 0
        and (t.channel_id is null or (not t.disputed and exists (
          select 1 from pack_channels p where p.channel_id = t.channel_id and p.status in ('pending', 'locked'))))))
    order by t.created_at desc limit 1`;
  if (live) return toPack(live, "live");
  if (!envToken) return null;
  const [env] = await sql<Omit<PackRow, "token">[]>`
    select id as credit_token_id, remaining, status, tx_hash, created_at as bought_at
    from credit_tokens where token_hash = ${sha256Hex(envToken)} and api_id = ${apiId}
      and (${!withCredits} or (status in ('active', 'pending') and remaining > 0))`;
  return env ? toPack({ ...env, token: envToken }, "env") : null;
}

/**
 * Why a paid try can't run now, or null when it can. Counted from the gateway's own call log for the pack's
 * token, so the cap holds across every serverless instance (a per-instance memory limit can't).
 */
export async function demoBudgetProblem(sql: Sql, token: string, perHour: number): Promise<string | null> {
  const [row] = await sql<{ id: string; remaining: number; status: string; used: number }[]>`
    select t.id, t.remaining, t.status,
           (select count(*)::int from calls c where c.credit_token_id = t.id and c.created_at > now() - interval '1 hour') as used
    from credit_tokens t where t.token_hash = ${sha256Hex(token)}`;
  // A pending pack goes through: the gateway answers token_pending until the payment settles.
  if (!row || (row.status !== "active" && row.status !== "pending") || row.remaining <= 0) return "This pack is used up. Buy a new one live.";
  if (row.used >= perHour) return "This pack has made its calls for this hour. Try again later.";
  return null;
}

/** The demo wallet's IOU state for escrow packs, kept on its try_tokens row. */
export function tryEscrowStore(sql: Sql): TryEscrowStore {
  return {
    async rule(hash) {
      const rows = await sql<{ definition: RuleDefinition }[]>`select definition from rules where hash = ${hash} limit 1`;
      // The stored row proves nothing by itself: the definition must hash to the promise the lock names.
      const def = rows[0]?.definition;
      return def && ruleHash(def) === hash ? def : null;
    },
    async countPass(tryId) {
      const [row] = await sql<{ iouVerified: number }[]>`
        update try_tokens set iou_verified = iou_verified + 1 where id = ${tryId} returning iou_verified`;
      return row?.iouVerified ?? 0;
    },
    async verified(tryId) {
      const [row] = await sql<{ iouVerified: number }[]>`select iou_verified from try_tokens where id = ${tryId}`;
      return row?.iouVerified ?? 0;
    },
    async saveIou(tryId, n, iou) {
      await sql`update try_tokens set iou_signed = ${n}, iou_last = ${iou} where id = ${tryId} and iou_signed < ${n}`;
    },
    async dispute(tryId) {
      await sql`update try_tokens set disputed = true where id = ${tryId}`;
    },
  };
}
