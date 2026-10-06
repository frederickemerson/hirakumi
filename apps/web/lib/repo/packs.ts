import { newId } from "@hirakumi/core";
import type { Sql } from "../db";
import type { ApiState, Pack, RepoResult } from "../types";

export async function getPack(sql: Sql, apiId: string): Promise<Pack | null> {
  const [row] = await sql<Pack[]>`
    select id, calls, price_micros::text as price_micros, escrow_price_micros::text as escrow_price_micros
    from packs where api_id = ${apiId} order by id limit 1`;
  return row ?? null;
}

export async function savePricing(
  sql: Sql,
  a: { apiId: string; sellerId: string; calls: number; priceMicros: bigint; escrowPriceMicros: bigint },
): Promise<RepoResult> {
  return sql.begin(async (tx): Promise<RepoResult> => {
    const [api] = await tx<{ state: ApiState }[]>`
      select state from apis where id = ${a.apiId} and seller_id = ${a.sellerId} for update`;
    if (!api) return { ok: false, status: 404, error: "We couldn't find that API in your account." };
    if (api.state !== "rule_built" && api.state !== "priced") {
      return { ok: false, status: 409, error: "Prices can only be set after the test calls and before publishing." };
    }
    const [missing] = await tx<{ count: number }[]>`
      select count(*)::int as count from operations o
      where o.api_id = ${a.apiId} and o.enabled and not exists (select 1 from rules r where r.operation_id = o.id)`;
    if (missing.count > 0) {
      return { ok: false, status: 409, error: "The test calls haven't finished for every endpoint yet. Wait a moment and reload." };
    }
    const updated = await tx`
      update packs set calls = ${a.calls}, price_micros = ${a.priceMicros.toString()}::bigint,
        escrow_price_micros = ${a.escrowPriceMicros.toString()}::bigint
      where api_id = ${a.apiId} returning id`;
    if (updated.length === 0) {
      await tx`
        insert into packs (id, api_id, calls, price_micros, escrow_price_micros)
        values (${newId("pk")}, ${a.apiId}, ${a.calls}, ${a.priceMicros.toString()}::bigint, ${a.escrowPriceMicros.toString()}::bigint)`;
    }
    await tx`update apis set state = 'priced' where id = ${a.apiId}`;
    return { ok: true };
  });
}
