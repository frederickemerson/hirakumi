import type postgres from "postgres";
import { isStatusOnlyRule, newId, requiredPhrasesOf, ruleHash, withRequiredPhrase, type RuleDefinition } from "@hirakumi/core";
import type { Sql } from "../db";
import type { RuleView } from "../types";

/** A stored definition as a RuleDefinition, or null for one too old or odd to judge (no contentType or schema). */
function asRule(definition: unknown): RuleDefinition | null {
  const d = definition as Partial<RuleDefinition> | null;
  return d && typeof d.contentType === "string" && d.schema && typeof d.schema === "object" ? (d as RuleDefinition) : null;
}

/** Latest rule version for each enabled operation, with what a text promise checks beyond the status. */
export async function listLatestRules(sql: Sql, apiId: string): Promise<RuleView[]> {
  const rows = await sql<Omit<RuleView, "statusOnly" | "requiredPhrases">[]>`
    select distinct on (o.id)
      o.id as operation_id, o.op_id, o.method, o.path, r.version, r.hash, r.definition, r.plain_english
    from operations o join rules r on r.operation_id = o.id
    where o.api_id = ${apiId} and o.enabled
    order by o.id, r.version desc`;
  return rows.map((r) => {
    const rule = asRule(r.definition);
    return { ...r, statusOnly: rule ? isStatusOnlyRule(rule) : false, requiredPhrases: rule ? requiredPhrasesOf(rule) : [] };
  });
}

export async function countEnabledWithoutRule(sql: Sql, apiId: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from operations o
    where o.api_id = ${apiId} and o.enabled and not exists (select 1 from rules r where r.operation_id = o.id)`;
  return row.count;
}

/** The states in which the promise can still change: once the listing registers, its hash is published. */
export const PROMISE_EDITABLE_STATES = ["rule_built", "priced"] as const;

export type AddPhraseResult =
  | { ok: true; version: number; hash: string; plainEnglish: string }
  | { ok: false; reason: "not_found" | "locked" };

/**
 * Saves a new version of an endpoint's text promise that also requires `phrase` (withRequiredPhrase: throws
 * RuleInferenceError for a JSON promise or a bad phrase). The gateway and publishing use the latest version, so
 * the new row is the promise from now on. The plain-English text is the previous one plus a sentence naming the
 * phrase. The API row is locked, so a publish can't slip in between the state check and the write.
 */
export async function addRequiredPhrase(
  sql: Sql,
  a: { apiId: string; sellerId: string; operationId: string; phrase: string },
): Promise<AddPhraseResult> {
  return sql.begin(async (tx): Promise<AddPhraseResult> => {
    const [api] = await tx<{ state: string }[]>`
      select state from apis where id = ${a.apiId} and seller_id = ${a.sellerId} and deleted_at is null for update`;
    if (!api) return { ok: false, reason: "not_found" };
    if (!(PROMISE_EDITABLE_STATES as readonly string[]).includes(api.state)) return { ok: false, reason: "locked" };
    const [latest] = await tx<{ version: number; definition: RuleDefinition; hash: string; plainEnglish: string | null }[]>`
      select r.version, r.definition, r.hash, r.plain_english
      from rules r join operations o on o.id = r.operation_id
      where r.operation_id = ${a.operationId} and o.api_id = ${a.apiId} and o.enabled
      order by r.version desc limit 1`;
    if (!latest) return { ok: false, reason: "not_found" };
    const next = withRequiredPhrase(latest.definition, a.phrase);
    const hash = ruleHash(next);
    // The phrase is there already: nothing changes.
    if (hash === latest.hash) return { ok: true, version: latest.version, hash, plainEnglish: latest.plainEnglish ?? "" };
    const plainEnglish = `${latest.plainEnglish ?? ""} Every good answer contains "${a.phrase.trim()}".`.trim();
    const version = latest.version + 1;
    await tx`
      insert into rules (id, operation_id, version, definition, hash, plain_english)
      values (${newId("rule")}, ${a.operationId}, ${version}, ${tx.json(next as unknown as postgres.JSONValue)}, ${hash}, ${plainEnglish})`;
    return { ok: true, version, hash, plainEnglish };
  });
}
