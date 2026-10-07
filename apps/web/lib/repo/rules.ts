import { addRequiredPhraseTx, isStatusOnlyRule, requiredPhrasesOf, type AddPhraseResult, type RuleDefinition } from "@hirakumi/core";
import type { Sql } from "../db";
import { queryOn } from "./apis";
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

/**
 * The phrase QA suggests for each status-only text promise, by operation id: onboard_steps(step='qa').output
 * .suggestedPhrases is keyed by opId (the OpenAPI operationId), like seller_samples. Only one-line strings count;
 * the seller confirms or edits the suggestion before it becomes part of the promise.
 */
export async function getSuggestedPhrases(sql: Sql, apiId: string): Promise<Record<string, string>> {
  const [row] = await sql<{ suggested: unknown }[]>`
    select output->'suggestedPhrases' as suggested from onboard_steps where api_id = ${apiId} and step = 'qa'`;
  const byOpId = row?.suggested && typeof row.suggested === "object" ? (row.suggested as Record<string, unknown>) : {};
  const ops = await sql<{ id: string; opId: string }[]>`select id, op_id from operations where api_id = ${apiId}`;
  const out: Record<string, string> = {};
  for (const op of ops) {
    const phrase = byOpId[op.opId];
    if (typeof phrase === "string" && phrase.trim() && !/[\r\n]/.test(phrase)) out[op.id] = phrase.trim();
  }
  return out;
}

export { PROMISE_EDITABLE_STATES, type AddPhraseResult } from "@hirakumi/core";

/**
 * Saves a new version of an endpoint's text promise that also requires `phrase` (@hirakumi/core addRequiredPhraseTx,
 * shared with the coworker's `phrase` reply). The gateway and publishing use the latest version, so the new row is
 * the promise from now on.
 */
export async function addRequiredPhrase(
  sql: Sql,
  a: { apiId: string; sellerId: string; operationId: string; phrase: string },
): Promise<AddPhraseResult> {
  return sql.begin((tx) => addRequiredPhraseTx(queryOn(tx), a));
}
