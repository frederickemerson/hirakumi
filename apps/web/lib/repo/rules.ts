import type { Sql } from "../db";
import type { RuleView } from "../types";

/** Latest rule version for each enabled operation. */
export async function listLatestRules(sql: Sql, apiId: string): Promise<RuleView[]> {
  return sql<RuleView[]>`
    select distinct on (o.id)
      o.id as operation_id, o.op_id, o.method, o.path, r.version, r.hash, r.definition, r.plain_english
    from operations o join rules r on r.operation_id = o.id
    where o.api_id = ${apiId} and o.enabled
    order by o.id, r.version desc`;
}

export async function countEnabledWithoutRule(sql: Sql, apiId: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from operations o
    where o.api_id = ${apiId} and o.enabled and not exists (select 1 from rules r where r.operation_id = o.id)`;
  return row.count;
}
