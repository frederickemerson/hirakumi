import { sha256Hex } from "@hirakumi/core";
import type { Sql } from "./db";

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
  source: "live" | "env";
};

/** Columns arrive camel-cased (lib/db transform). */
type PackRow = { token: string; creditTokenId: string; remaining: number; status: string; txHash: string | null; boughtAt: Date };

const toPack = (r: PackRow, source: TryPack["source"]): TryPack => ({
  token: r.token, creditTokenId: r.creditTokenId, remaining: r.remaining, pending: r.status === "pending",
  txHash: r.txHash, boughtAt: r.boughtAt, source,
});

/**
 * The newest pack for this API, live purchases first, then the TRY_CREDIT_TOKENS fallback. With
 * `withCredits` (the default) only a pack that can still pay is returned; without it, the newest one at all
 * (its receipts stay readable after the credits run out).
 */
export async function findTryPack(
  sql: Sql,
  apiId: string,
  envToken: string | undefined,
  opts: { withCredits?: boolean } = {},
): Promise<TryPack | null> {
  const withCredits = opts.withCredits ?? true;
  const [live] = await sql<PackRow[]>`
    select t.token, c.id as credit_token_id, c.remaining, c.status, coalesce(t.tx_hash, c.tx_hash) as tx_hash, t.created_at as bought_at
    from try_tokens t join credit_tokens c on c.token_hash = t.token_hash and c.api_id = t.api_id
    where t.api_id = ${apiId} and t.status = 'active'
      and (${!withCredits} or (c.status in ('active', 'pending') and c.remaining > 0))
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
