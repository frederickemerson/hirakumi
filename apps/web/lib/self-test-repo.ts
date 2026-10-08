import { newId, sha256Hex } from "@hirakumi/core";
import type { Sql } from "./db";
import { toPack, type PackRow, type TryPack } from "./try-repo";

/**
 * Free self tests one seller gets across all listings: the gateway's TRY_LIMITS.freeTestsPerSeller, which is what
 * enforces it (apps/gateway/src/demoBuy.ts). The web only reads it to say how many are left.
 */
const FREE_TESTS_PER_SELLER = 3;

export type SelfTestStatus = {
  /** This listing's free test was bought (or is being bought). A void attempt spent nothing and doesn't count. */
  freeTestUsed: boolean;
  /** Free tests this seller has left on other listings. */
  freeTestsLeft: number;
};

export async function getSelfTestStatus(sql: Sql, apiId: string, sellerId: string): Promise<SelfTestStatus> {
  const [row] = await sql<{ listing: boolean; seller: number }[]>`
    select exists (select 1 from try_tokens where api_id = ${apiId} and self_test_seller_id is not null and status <> 'void') as listing,
           (select count(*)::int from try_tokens where self_test_seller_id = ${sellerId} and status <> 'void') as seller`;
  return { freeTestUsed: row.listing, freeTestsLeft: Math.max(0, FREE_TESTS_PER_SELLER - row.seller) };
}

/**
 * The pack this seller's Try it live pays with: the newest of their free test (try_tokens, demo wallet) and the
 * packs they bought with their own wallet (self_test_packs). Never a public showcase pack, never another seller's.
 * With `withCredits` (the default) only a pack that can still pay; without it, the newest one (for its receipts).
 */
export async function findSelfTestPack(
  sql: Sql,
  apiId: string,
  sellerId: string,
  opts: { withCredits?: boolean } = {},
): Promise<TryPack | null> {
  const withCredits = opts.withCredits ?? true;
  const rows = await sql<(PackRow & { source: "live" | "wallet" })[]>`
    select * from (
      select 'live' as source, t.token, c.id as credit_token_id, c.remaining, c.status, coalesce(t.tx_hash, c.tx_hash) as tx_hash,
             t.created_at as bought_at, t.id as try_id, t.channel_id, t.iou_secret, t.rule_hash, t.iou_last
      from try_tokens t join credit_tokens c on c.token_hash = t.token_hash and c.api_id = t.api_id
      where t.api_id = ${apiId} and t.self_test_seller_id = ${sellerId} and t.status = 'active'
        and (${!withCredits} or (c.status in ('active', 'pending') and c.remaining > 0
          and (t.channel_id is null or (not t.disputed and exists (
            select 1 from pack_channels p where p.channel_id = t.channel_id and p.status in ('pending', 'locked'))))))
      union all
      select 'wallet' as source, s.token, c.id, c.remaining, c.status, coalesce(s.tx_hash, c.tx_hash),
             s.created_at, null, null, null, null, null
      from self_test_packs s join credit_tokens c on c.token_hash = s.token_hash and c.api_id = s.api_id
      where s.api_id = ${apiId} and s.seller_id = ${sellerId}
        and (${!withCredits} or (c.status in ('active', 'pending') and c.remaining > 0))
    ) packs order by bought_at desc limit 1`;
  const r = rows[0];
  return r ? toPack(r, r.source) : null;
}

/** A pack the seller bought with their own wallet. The token stays server-side, like the demo wallet's. */
export async function saveSelfTestPack(
  sql: Sql,
  p: { apiId: string; sellerId: string; token: string; txHash: string | null; credits: number },
): Promise<void> {
  await sql`
    insert into self_test_packs (id, api_id, seller_id, token, token_hash, tx_hash, credits)
    values (${newId("try")}, ${p.apiId}, ${p.sellerId}, ${p.token}, ${sha256Hex(p.token)}, ${p.txHash}, ${p.credits})
    on conflict (token_hash) do nothing`;
}
