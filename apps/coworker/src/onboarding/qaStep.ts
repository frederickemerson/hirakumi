import { isStatusOnlyRule, newId, ruleHash, type RuleDefinition } from "@hirakumi/core";
import type pg from "pg";
import { withTx } from "../db.js";
import { PermanentError } from "../errors.js";
import type { GatewayClient } from "../gateway.js";
import { apiLink, reviewLink } from "../links.js";
import { formatTusdm, SUGGESTED_PACK } from "../sokosumi/replies.js";
import type { StructuredCall } from "../llm/claude.js";
import { writeRuleText } from "../llm/ruleText.js";
import { enqueueMessage } from "../messages.js";
import type { InputSchema } from "../openapi/parse.js";
import { buildBadInput, buildGoodInputs } from "../qa/inputs.js";
import { MIN_CALLS, NeedsKeyError, qaOperation, type GoodAnswer } from "../qa/runQa.js";
import { finishStep, getStep, runStep, saveStepOutput, type StepOutcome } from "../steps.js";

export type QaDeps = { pool: pg.Pool; gateway: GatewayClient; llm: StructuredCall; webBaseUrl: string; now?: () => Date };
type OpRow = { id: string; op_id: string; description: string | null; input_schema: InputSchema };
export type OpQaSummary = { opId: string; calls: number; badInput: "rejected" | "skipped" | "reused" };

/** Optional seller samples (contract addition): onboard_steps(step='seller_samples').output = { [opId]: input[] }. */
async function sellerSamples(pool: pg.Pool, apiId: string): Promise<Record<string, Record<string, unknown>[]>> {
  const { rows } = await pool.query<{ output: unknown }>(`select output from onboard_steps where api_id = $1 and step = 'seller_samples'`, [apiId]);
  const out = rows[0]?.output;
  if (!out || typeof out !== "object" || Array.isArray(out)) return {};
  const clean: Record<string, Record<string, unknown>[]> = {};
  for (const [opId, list] of Object.entries(out as Record<string, unknown>)) {
    if (Array.isArray(list)) clean[opId] = list.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x));
  }
  return clean;
}

/** Suggested required phrases by op id: onboard_steps(step='qa').output.suggestedPhrases (the review page prefills them). */
export type SuggestedPhrases = Record<string, string>;

function savedSuggestions(output: Record<string, unknown> | null | undefined): SuggestedPhrases {
  const saved = output?.suggestedPhrases;
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
  return Object.fromEntries(Object.entries(saved).filter((e): e is [string, string] => typeof e[1] === "string"));
}

/**
 * Good text answers by op id: onboard_steps(step='qa').output.goodAnswers. The review page checks a phrase the
 * seller types against them (apps/web lib/repo/rules.ts addRequiredPhrase).
 */
export type GoodAnswers = Record<string, GoodAnswer[]>;

function savedGoodAnswers(output: Record<string, unknown> | null | undefined): GoodAnswers {
  const saved = output?.goodAnswers;
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
  return Object.fromEntries(Object.entries(saved).filter((e): e is [string, GoodAnswer[]] => Array.isArray(e[1])));
}

/** Live sub-progress for the seller's timeline: onboard_steps(step='qa').output.progress. */
export type QaProgress = { done: number; total: number; startedAt: string };

/** How many upstream calls qaOperation makes for one operation: its plan of good calls plus one bad-input call. */
export function plannedCalls(op: Pick<OpRow, "op_id" | "input_schema">, samples: Record<string, unknown>[]): number {
  const inputs = buildGoodInputs(op.input_schema, samples, op.op_id);
  return Math.max(MIN_CALLS, inputs.length) + (buildBadInput(op.input_schema, inputs[0]) ? 1 : 0);
}

/**
 * Wraps the gateway so every finished test call is counted and written to the step output, in order.
 * Progress writes are best effort: a failed write never fails the QA run.
 */
function withProgress(deps: QaDeps, apiId: string, total: number): { gateway: GatewayClient; flush: () => Promise<void> } {
  const startedAt = (deps.now?.() ?? new Date()).toISOString();
  let done = 0;
  let writes = Promise.resolve();
  const report = () => {
    const progress: QaProgress = { done, total: Math.max(total, done), startedAt };
    writes = writes.then(() => saveStepOutput(deps.pool, apiId, "qa", { progress })).catch(() => {});
  };
  report();
  return {
    gateway: {
      ...deps.gateway,
      preview: async (...args: Parameters<GatewayClient["preview"]>) => {
        try {
          return await deps.gateway.preview(...args);
        } finally {
          done += 1;
          report();
        }
      },
    },
    flush: () => writes,
  };
}

/** ownership_verified → rule_built: QA every enabled op, save rule + test inputs, then plain English + listing. */
export async function qaStep(deps: QaDeps, apiId: string): Promise<StepOutcome> {
  return runStep(deps.pool, apiId, "qa", async () => {
    const { rows: ops } = await deps.pool.query<OpRow>(
      `select id, op_id, description, input_schema from operations where api_id = $1 and enabled order by op_id`,
      [apiId],
    );
    if (!ops.length) throw new PermanentError("No endpoints are switched on, so there is nothing to test. Turn on at least one endpoint.");
    const { rows: [api] } = await deps.pool.query<{ name: string; sokosumi_task_id: string | null }>(`select name, sokosumi_task_id from apis where id = $1`, [apiId]);
    if (!api) throw new PermanentError(`API ${apiId} no longer exists.`); // runStep sees it is gone and stops quietly
    if (api.sokosumi_task_id) {
      await enqueueMessage(deps.pool, {
        apiId,
        body: `Ownership proven. Running test calls on ${ops.length} endpoint(s) now; this takes about a minute.`,
        taskStatus: "RUNNING",
        dedupeKey: `qa_started:${apiId}`,
        step: "Test calls",
      });
    }
    const samples = await sellerSamples(deps.pool, apiId);
    const { rows: ruled } = await deps.pool.query<{ operation_id: string }>(
      `select operation_id from rules where operation_id = any($1::text[]) and version = 1`,
      [ops.map((o) => o.id)],
    );
    const hasRule = new Set(ruled.map((r) => r.operation_id));
    const total = ops.filter((o) => !hasRule.has(o.id)).reduce((n, o) => n + plannedCalls(o, samples[o.op_id] ?? []), 0);
    // Read before the progress writes start; they only merge into the output, so saved suggestions survive a crash.
    const previous = await getStep(deps.pool, apiId, "qa");
    const suggestedPhrases = savedSuggestions(previous?.output);
    const goodAnswers = savedGoodAnswers(previous?.output);
    const counted = withProgress(deps, apiId, total);
    const summaries: OpQaSummary[] = [];
    const forText: { opId: string; description: string | null; rule: RuleDefinition }[] = [];
    let exampleOutput: string | null = null;

    for (const op of ops) {
      const existing = await deps.pool.query<{ definition: RuleDefinition }>(`select definition from rules where operation_id = $1 and version = 1`, [op.id]);
      if (existing.rows[0]) {
        forText.push({ opId: op.op_id, description: op.description, rule: existing.rows[0].definition });
        summaries.push({ opId: op.op_id, calls: 0, badInput: "reused" });
        continue;
      }
      const r = await qaOperation(counted.gateway, apiId, op, samples[op.op_id] ?? []).catch((e: unknown) => {
        // The failure message is all the seller gets (also on a Sokosumi task), so it links the key form.
        throw e instanceof NeedsKeyError ? new PermanentError(`${e.message} Review page: ${reviewLink(deps.webBaseUrl, apiId)}`) : e;
      });
      await withTx(deps.pool, async (c) => {
        await c.query(
          `insert into rules (id, operation_id, version, definition, hash) values ($1, $2, 1, $3::jsonb, $4)
           on conflict (operation_id, version) do nothing`,
          [newId("rule"), op.id, JSON.stringify(r.rule), ruleHash(r.rule)],
        );
        await c.query(`delete from test_inputs where operation_id = $1`, [op.id]);
        for (const input of r.testInputs) {
          await c.query(`insert into test_inputs (id, operation_id, input) values ($1, $2, $3::jsonb)`, [newId("ti"), op.id, JSON.stringify(input)]);
        }
        if (r.suggestedPhrase) suggestedPhrases[op.op_id] = r.suggestedPhrase;
        else delete suggestedPhrases[op.op_id];
        if (r.goodAnswers.length) goodAnswers[op.op_id] = r.goodAnswers;
        else delete goodAnswers[op.op_id];
        await saveStepOutput(c, apiId, "qa", { suggestedPhrases, goodAnswers });
      });
      exampleOutput ??= r.exampleOutput;
      forText.push({ opId: op.op_id, description: op.description, rule: r.rule });
      summaries.push({ opId: op.op_id, calls: r.calls, badInput: r.badInput });
    }

    await counted.flush();
    const text = await writeRuleText(deps.llm, { apiName: api.name, ops: forText });
    const phrases = phraseLines(forText, suggestedPhrases);
    await withTx(deps.pool, async (c) => {
      for (const op of ops) {
        await c.query(`update rules set plain_english = $2 where operation_id = $1 and version = 1 and plain_english is null`, [op.id, text.texts.get(op.op_id)]);
      }
      const moved = await c.query(`update apis set state = 'rule_built' where id = $1 and state = 'ownership_verified'`, [apiId]);
      if (moved.rowCount !== 1) return;
      await finishStep(c, apiId, "qa", {
        ops: summaries,
        listing: text.listing,
        exampleOutput: exampleOutput ?? (previous?.output?.exampleOutput as string | undefined) ?? null,
        usedFallbackText: text.usedFallback,
        suggestedPhrases,
        goodAnswers,
      });
      await enqueueMessage(c, {
        apiId,
        body: `${qaSummaryLine(summaries)} Your promise to buyers: ${[...text.texts.values()].join(" ")}${phrases.map((l) => ` ${l}`).join("")}` +
          (api.sokosumi_task_id
            ? ` Suggested price: ${formatTusdm(SUGGESTED_PACK.priceMicros)} tUSDM for ${SUGGESTED_PACK.calls} calls. Reply \`price ${formatTusdm(SUGGESTED_PACK.priceMicros)}\` to accept it, or another amount (like \`price 3.5 for 200 calls\`). ` +
              `Then approve publishing with your wallet (one signature): ${reviewLink(deps.webBaseUrl, apiId)}`
            : ` Review the price and publish: ${apiLink(deps.webBaseUrl, apiId)}`),
        taskStatus: "INPUT_REQUIRED",
        dedupeKey: `rule_built:${apiId}`,
        step: "Write the promise",
      });
    });
  }, deps.now?.());
}

/** Audit M3: say only what the QA run actually checked. */
export function qaSummaryLine(summaries: OpQaSummary[]): string {
  const totalCalls = summaries.reduce((n, s) => n + s.calls, 0);
  const rejected = summaries.filter((s) => s.badInput === "rejected").length;
  const bad = rejected === 0
    ? ""
    : rejected === summaries.length
      ? " and a wrong request was correctly rejected"
      : `, and a wrong request was correctly rejected on ${rejected} of ${summaries.length} endpoints`;
  return `Test calls done: ${totalCalls} calls across ${summaries.length} endpoint(s) all passed${bad}.`;
}

/**
 * What the seller must do about status-only text promises (core isStatusOnlyRule) before publishing, one line per
 * such operation: confirm or change the suggested phrase, or type one when QA found none. Publishing is refused
 * until each has a phrase. A suggestion is never saved on its own: answers gathered within seconds can't show that
 * it stays the same, the seller can.
 */
export function phraseLines(ops: { opId: string; rule: RuleDefinition }[], suggested: SuggestedPhrases): string[] {
  const statusOnly = ops.filter((o) => isStatusOnlyRule(o.rule));
  const one = ops.length === 1;
  return statusOnly.map(({ opId }) => {
    const phrase = suggested[opId];
    if (phrase) {
      return `${one ? "Before you publish, confirm" : `For ${opId}, confirm`} the phrase ${JSON.stringify(phrase)} on the review page or type another. ` +
        "Every good answer must contain it, so it can't be a date, a version or a count.";
    }
    return `${one ? "This promise" : `The promise for ${opId}`} only checks the status, so it needs a phrase before you can publish. ` +
      "Add one on the review page: a word or label every good answer contains, like Price or Symbol. Capital letters don't matter.";
  });
}
