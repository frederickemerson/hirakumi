import { compileRule, inferRuleFromResponses, isJsonMediaType, isTextMediaType, mediaTypeOf, RuleInferenceError, suggestPhrase, type RuleDefinition } from "@hirakumi/core";
import { PermanentError } from "../errors.js";
import type { GatewayClient, PreviewResult } from "../gateway.js";
import type { InputSchema } from "../openapi/parse.js";
import { buildBadInput, buildGoodInputs } from "./inputs.js";

export const MIN_CALLS = 5;

export type QaOperation = { op_id: string; input_schema: InputSchema };
export type OpQaResult = {
  rule: RuleDefinition;
  testInputs: Record<string, unknown>[];
  calls: number;
  badInput: "rejected" | "skipped";
  exampleOutput: string;
  /** For a text rule: a phrase every good answer contains and the wrong request's answer does not (core suggestPhrase), or null. */
  suggestedPhrase: string | null;
  /** For a text rule: the different good answers, so a phrase the seller types can be checked against them. Empty for JSON. */
  goodAnswers: GoodAnswer[];
};

/** A good test answer as stored with the QA output: the first MAX_GOOD_ANSWER_LENGTH characters, and whether that is all of it. */
export type GoodAnswer = { body: string; complete: boolean };
export const MAX_GOOD_ANSWERS = 5;
export const MAX_GOOD_ANSWER_LENGTH = 32_000;

function parseJson(body: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch {
    return { ok: false };
  }
}

/** A success Hirakumi can write a promise for: JSON that parses (any JSON media type), or a text type. */
const isGoodAnswer = (r: PreviewResult) => {
  if (r.status < 200 || r.status >= 300) return false;
  const ct = mediaTypeOf(r.contentType);
  return isJsonMediaType(ct) ? parseJson(r.body).ok : isTextMediaType(ct);
};

/** The API refused the test calls (401/403): it needs a key Hirakumi doesn't have yet. */
export class NeedsKeyError extends PermanentError {}

const CANT_TELL_APART = (opId: string) =>
  `A deliberately wrong request to ${opId} got an answer that looks like a good one, so the promise can't tell them apart. Make your API return an error (HTTP 4xx) for unknown input, then try again.`;

/** At least MIN_CALLS parallel good calls + one bad-input call, then infer and self-check the rule. */
export async function qaOperation(
  gateway: GatewayClient,
  apiId: string,
  op: QaOperation,
  sellerSamples: Record<string, unknown>[],
): Promise<OpQaResult> {
  const inputs = buildGoodInputs(op.input_schema, sellerSamples, op.op_id);
  const plan = Array.from({ length: Math.max(MIN_CALLS, inputs.length) }, (_, i) => inputs[i % inputs.length]);
  const results = await Promise.all(plan.map((input) => gateway.preview(apiId, op.op_id, input)));
  const failedAt = results.findIndex((r) => !isGoodAnswer(r));
  if (failedAt >= 0) {
    const r = results[failedAt];
    const ct = mediaTypeOf(r.contentType);
    if (r.status >= 200 && r.status < 300 && ct && !isJsonMediaType(ct) && !isTextMediaType(ct)) {
      throw new PermanentError(`${op.op_id} answers with ${ct}, which Hirakumi can't check yet. It checks JSON and text answers (such as CSV, XML or plain text).`);
    }
    if (r.status === 401 || r.status === 403) {
      throw new NeedsKeyError(`Test calls to ${op.op_id} were refused (HTTP ${r.status}). If your API needs a key, add it on the review page. The test calls then run again.`);
    }
    throw new Error(`test call ${failedAt + 1} of ${plan.length} to ${op.op_id} did not return a success Hirakumi can check (HTTP ${r.status}): ${r.body.slice(0, 200)}`);
  }
  const bad = buildBadInput(op.input_schema, inputs[0]);
  const badResult = bad ? await gateway.preview(apiId, op.op_id, bad) : null;
  let rule: RuleDefinition;
  try {
    rule = inferRuleFromResponses(results, badResult);
  } catch (e) {
    // No rule can tell the error answer from a good one, or the answers can't be checked. Retrying can't fix that.
    if (e instanceof RuleInferenceError) throw new PermanentError(/error response/.test(e.message) ? CANT_TELL_APART(op.op_id) : `${op.op_id}: ${e.message}`);
    throw e;
  }
  const compiled = compileRule(rule);
  for (const r of results) {
    const v = compiled.check(r);
    if (!v.pass) throw new PermanentError(`The promise we built for ${op.op_id} rejects one of your own good answers (${v.reasons.join("; ")}).`);
  }
  if (badResult && compiled.check(badResult).pass) throw new PermanentError(CANT_TELL_APART(op.op_id));
  // A phrase only from answers to at least two different inputs: the answers to one input all share its own words.
  const differentInputs = new Set(plan.map((input) => JSON.stringify(input))).size >= 2;
  const suggestedPhrase = isJsonMediaType(rule.contentType) || !differentInputs ? null : suggestPhrase(results.map((r) => r.body), badResult?.body);
  return {
    rule,
    testInputs: inputs,
    calls: plan.length + (bad ? 1 : 0),
    badInput: bad ? "rejected" : "skipped",
    exampleOutput: results[0].body.slice(0, 1000),
    suggestedPhrase,
    goodAnswers: isJsonMediaType(rule.contentType)
      ? []
      : [...new Set(results.map((r) => r.body))].slice(0, MAX_GOOD_ANSWERS)
        .map((body) => ({ body: body.slice(0, MAX_GOOD_ANSWER_LENGTH), complete: body.length <= MAX_GOOD_ANSWER_LENGTH })),
  };
}
