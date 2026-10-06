import { compileRule, inferRule, type RuleDefinition } from "@hirakumi/core";
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
};

function parseJson(body: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch {
    return { ok: false };
  }
}

const isGoodJson = (r: PreviewResult) =>
  r.status >= 200 && r.status < 300 && (r.contentType ?? "").toLowerCase().includes("json") && parseJson(r.body).ok;

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
  const failedAt = results.findIndex((r) => !isGoodJson(r));
  if (failedAt >= 0) {
    const r = results[failedAt];
    throw new Error(`test call ${failedAt + 1} of ${plan.length} to ${op.op_id} did not return a JSON success (HTTP ${r.status}): ${r.body.slice(0, 200)}`);
  }
  const samples = results.map((r) => JSON.parse(r.body) as unknown);
  const bad = buildBadInput(op.input_schema, inputs[0]);
  const badResult = bad ? await gateway.preview(apiId, op.op_id, bad) : null;
  const badBody = badResult ? parseJson(badResult.body) : null;
  let rule: RuleDefinition;
  try {
    rule = inferRule(samples, badBody ? (badBody.ok ? badBody.value : badResult!.body) : undefined);
  } catch {
    // Core's inferRule refuses when no rule can tell the error answer from a good one. Retrying can't fix that.
    throw new PermanentError(
      `A deliberately wrong request to ${op.op_id} got an answer that looks like a good one, so the promise can't tell them apart. Make your API return an error (HTTP 4xx) for unknown input, then try again.`,
    );
  }
  const compiled = compileRule(rule);
  for (const r of results) {
    const v = compiled.check(r);
    if (!v.pass) throw new PermanentError(`The promise we built for ${op.op_id} rejects one of your own good answers (${v.reasons.join("; ")}).`);
  }
  if (badResult && compiled.check(badResult).pass) {
    throw new PermanentError(
      `A deliberately wrong request to ${op.op_id} got an answer that looks like a good one, so the promise can't tell them apart. Make your API return an error (HTTP 4xx) for unknown input, then try again.`,
    );
  }
  return { rule, testInputs: inputs, calls: plan.length + (bad ? 1 : 0), badInput: bad ? "rejected" : "skipped", exampleOutput: results[0].body.slice(0, 1000) };
}
