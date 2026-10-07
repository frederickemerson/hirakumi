import type postgres from "postgres";
import {
  compileRule, isStatusOnlyRule, newId, requiredPhrasesOf, ruleHash, RuleInferenceError, withRequiredPhrase, type RuleDefinition,
} from "@hirakumi/core";
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

/** The last sentence of a status-only promise's plain English (apps/coworker src/llm/ruleText.ts). */
const STATUS_ONLY_SENTENCE = " This is a status-only promise: it does not check the content.";

/** The states in which the promise can still change: once the listing registers, its hash is published. */
export const PROMISE_EDITABLE_STATES = ["rule_built", "priced"] as const;

/**
 * The good test answers QA stored for an operation: onboard_steps(step='qa').output.goodAnswers, keyed by opId
 * (apps/coworker qaStep). Only answers stored whole count; a cut answer can't show that a phrase is missing.
 * Empty for an API tested before QA stored them.
 */
async function storedGoodAnswers(tx: postgres.TransactionSql, apiId: string, operationId: string): Promise<string[]> {
  const [row] = await tx<{ answers: unknown }[]>`
    select s.output->'goodAnswers'->o.op_id as answers
    from operations o join onboard_steps s on s.api_id = o.api_id and s.step = 'qa'
    where o.id = ${operationId} and o.api_id = ${apiId}`;
  if (!Array.isArray(row?.answers)) return [];
  return (row.answers as { body?: unknown; complete?: unknown }[])
    .filter((a) => a && typeof a.body === "string" && a.complete === true)
    .map((a) => a.body as string);
}

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
    // A phrase one of the seller's own good answers lacks would make the promise refuse them.
    const rule = compileRule(next);
    const missing = (await storedGoodAnswers(tx, a.apiId, a.operationId)).some((body) =>
      rule.check({ status: 200, contentType: next.contentType, body, latencyMs: 0 }).reasons.some((r) => r.includes(" does not contain ")));
    if (missing) {
      throw new RuleInferenceError(`Not every good answer from your test calls contains "${a.phrase.trim()}", so the promise would refuse your own answers. Pick a word or label every answer has.`);
    }
    const hash = ruleHash(next);
    // The phrase is there already: nothing changes.
    if (hash === latest.hash) return { ok: true, version: latest.version, hash, plainEnglish: latest.plainEnglish ?? "" };
    // The coworker ends a status-only promise's text with STATUS_ONLY_SENTENCE; with a phrase it no longer is one.
    const previous = (latest.plainEnglish ?? "").replace(STATUS_ONLY_SENTENCE, "");
    const plainEnglish = `${previous} Every good answer contains "${a.phrase.trim()}".`.trim();
    const version = latest.version + 1;
    await tx`
      insert into rules (id, operation_id, version, definition, hash, plain_english)
      values (${newId("rule")}, ${a.operationId}, ${version}, ${tx.json(next as unknown as postgres.JSONValue)}, ${hash}, ${plainEnglish})`;
    return { ok: true, version, hash, plainEnglish };
  });
}
