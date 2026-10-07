import { newId } from "./ids";
import type { QueryFn } from "./listingBase";
import { compileRule, RuleInferenceError, ruleHash, withRequiredPhrase, type RuleDefinition } from "./rules";

/**
 * "Every good answer contains": a new version of an endpoint's text promise that also requires a phrase. Shared by
 * the web's review page (apps/web lib/repo/rules.ts) and the coworker's `phrase` reply, so both keep one rule.
 */

/** The states in which the promise can still change: once the listing registers, its hash is published. */
export const PROMISE_EDITABLE_STATES = ["rule_built", "priced"] as const;

/** The last sentence of a status-only promise's plain English (apps/coworker src/llm/ruleText.ts). */
export const STATUS_ONLY_SENTENCE = " This is a status-only promise: it does not check the content.";

export type AddPhraseResult =
  | { ok: true; version: number; hash: string; plainEnglish: string }
  | { ok: false; reason: "not_found" | "locked" };

/**
 * Run inside a transaction (`query` on it): the API row is locked, so a publish can't slip in between the state
 * check and the write. Throws RuleInferenceError for a JSON promise, a bad phrase, or a phrase one of the seller's
 * own good test answers lacks (onboard_steps(step='qa').output.goodAnswers, whole answers only). sellerId, when
 * given, must own the API. Column names are single words for both drivers.
 */
export async function addRequiredPhraseTx(
  query: QueryFn,
  a: { apiId: string; sellerId?: string; operationId: string; phrase: string },
): Promise<AddPhraseResult> {
  const [api] = await query(
    `select state from apis where id = $1 and ($2::text is null or seller_id = $2) and deleted_at is null for update`,
    [a.apiId, a.sellerId ?? null],
  );
  if (!api) return { ok: false, reason: "not_found" };
  if (!(PROMISE_EDITABLE_STATES as readonly string[]).includes(String(api.state))) return { ok: false, reason: "locked" };
  const [latest] = await query(
    `select r.version, r.definition, r.hash, r.plain_english as english
     from rules r join operations o on o.id = r.operation_id
     where r.operation_id = $1 and o.api_id = $2 and o.enabled
     order by r.version desc limit 1`,
    [a.operationId, a.apiId],
  );
  if (!latest) return { ok: false, reason: "not_found" };
  const definition = latest.definition as RuleDefinition;
  const next = withRequiredPhrase(definition, a.phrase);
  // A phrase one of the seller's own good answers lacks would make the promise refuse them.
  const rule = compileRule(next);
  const [stored] = await query(
    `select s.output->'goodAnswers'->o.op_id as answers
     from operations o join onboard_steps s on s.api_id = o.api_id and s.step = 'qa'
     where o.id = $1 and o.api_id = $2`,
    [a.operationId, a.apiId],
  );
  const answers = Array.isArray(stored?.answers)
    ? (stored.answers as { body?: unknown; complete?: unknown }[]).filter((x) => x && typeof x.body === "string" && x.complete === true).map((x) => x.body as string)
    : [];
  const missing = answers.some((body) =>
    rule.check({ status: 200, contentType: next.contentType, body, latencyMs: 0 }).reasons.some((r) => r.includes(" does not contain ")));
  if (missing) {
    throw new RuleInferenceError(`Not every good answer from your test calls contains "${a.phrase.trim()}", so the promise would refuse your own answers. Pick a word or label every answer has.`);
  }
  const hash = ruleHash(next);
  const version = Number(latest.version);
  const english = typeof latest.english === "string" ? latest.english : "";
  // The phrase is there already: nothing changes.
  if (hash === latest.hash) return { ok: true, version, hash, plainEnglish: english };
  // The coworker ends a status-only promise's text with STATUS_ONLY_SENTENCE; with a phrase it no longer is one.
  const plainEnglish = `${english.replace(STATUS_ONLY_SENTENCE, "")} Every good answer contains "${a.phrase.trim()}".`.trim();
  await query(
    `insert into rules (id, operation_id, version, definition, hash, plain_english) values ($1, $2, $3, $4::jsonb, $5, $6)`,
    // The object itself: pg and postgres.js each serialise it for jsonb (a JSON string would be stored as a string).
    [newId("rule"), a.operationId, version + 1, next, hash, plainEnglish],
  );
  return { ok: true, version: version + 1, hash, plainEnglish };
}
