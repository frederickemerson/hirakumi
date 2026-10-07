import { inferRuleFromResponses, withRequiredPhrase } from "@hirakumi/core";
import { fallbackRuleText } from "../src/llm/ruleText.js";
import { phraseLines, qaSummaryLine } from "../src/onboarding/qaStep.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { GatewayClient, PreviewResult } from "../src/gateway.js";
import type { StructuredCall } from "../src/llm/claude.js";
import { qaStep } from "../src/onboarding/qaStep.js";
import { INVALID_STRING } from "../src/qa/inputs.js";
import { getStep } from "../src/steps.js";
import { createTestDb, messagesFor, seedApi, seedOperation, type TestDb } from "./helpers/db.js";

let db: TestDb;
beforeAll(async () => (db = await createTestDb()));
afterAll(async () => db.close());

const json = (status: number, body: unknown): PreviewResult => ({ status, contentType: "application/json", body: JSON.stringify(body), latencyMs: 5 });
const gatewayFake = () => {
  const preview = vi.fn(async (_a: string, _o: string, i: Record<string, unknown>) =>
    i.symbol === INVALID_STRING ? json(404, { error: "unknown symbol" }) : json(200, { symbol: i.symbol, price: 0.31 }),
  );
  return { gateway: { preview } as GatewayClient, preview };
};
const llm = vi.fn().mockResolvedValue({
  rules: [{ opId: "getPrice", promise: "A response counts as good when it has the symbol and a numeric price." }],
  listing: { summary: "Live crypto prices", description: "Current prices for major tickers.", tags: ["crypto", "prices"] },
}) as unknown as StructuredCall;

describe("qaStep (ownership_verified → rule_built)", () => {
  it("saves rule, plain English and test inputs, then asks the seller to review", async () => {
    const apiId = await seedApi(db.pool, { state: "ownership_verified" });
    const opRowId = await seedOperation(db.pool, apiId);
    const { gateway, preview } = gatewayFake();
    expect(await qaStep({ pool: db.pool, gateway, llm, webBaseUrl: "https://web.test" }, apiId)).toBe("ran");
    expect(preview).toHaveBeenCalledTimes(6);
    const { rows: [rule] } = await db.pool.query(`select version, hash, plain_english, definition from rules where operation_id = $1`, [opRowId]);
    expect(rule.version).toBe(1);
    expect(rule.hash).toMatch(/^sha256:/);
    // The buyer-facing promise is derived from the rule, never written by the model (audit I3).
    expect(rule.plain_english).toBe(fallbackRuleText(rule.definition));
    const { rows: inputs } = await db.pool.query(`select input from test_inputs where operation_id = $1 order by input->>'symbol'`, [opRowId]);
    expect(inputs.map((r) => r.input)).toEqual([{ symbol: "ADA" }, { symbol: "BTC" }]);
    expect((await db.pool.query(`select state from apis where id = $1`, [apiId])).rows[0].state).toBe("rule_built");
    expect((await getStep(db.pool, apiId, "qa"))?.output).toMatchObject({ listing: { tags: ["crypto", "prices"] }, ops: [{ opId: "getPrice", calls: 6, badInput: "rejected" }] });
    expect((await messagesFor(db.pool, apiId)).at(-1)?.body).toMatch(/^Test calls done: 6 calls .* Review the price and publish: https:\/\/web\.test\/apis\//);
  });

  it("writes live progress {done, total} into the step output as test calls finish", async () => {
    const apiId = await seedApi(db.pool, { state: "ownership_verified" });
    await seedOperation(db.pool, apiId);
    const seen: unknown[] = [];
    const preview = vi.fn(async (_a: string, _o: string, i: Record<string, unknown>) => {
      if (i.symbol === INVALID_STRING) {
        // The bad-input call runs after the five good ones: by then their progress is on the step row.
        await vi.waitFor(async () => {
          const progress = (await getStep(db.pool, apiId, "qa"))?.output?.progress as { done: number } | undefined;
          expect(progress?.done).toBe(5);
          seen.push(progress);
        });
        return json(404, { error: "unknown symbol" });
      }
      return json(200, { symbol: i.symbol, price: 0.31 });
    });
    const now = new Date("2026-10-06T10:00:00Z");
    expect(await qaStep({ pool: db.pool, gateway: { preview } as GatewayClient, llm, webBaseUrl: "https://web.test", now: () => now }, apiId)).toBe("ran");
    expect(seen.at(-1)).toEqual({ done: 5, total: 6, startedAt: now.toISOString() });
    expect((await getStep(db.pool, apiId, "qa"))?.output?.progress).toEqual({ done: 6, total: 6, startedAt: now.toISOString() });
  });

  it("re-running after a crash reuses saved rules instead of calling upstream again", async () => {
    const apiId = await seedApi(db.pool, { state: "ownership_verified" });
    await seedOperation(db.pool, apiId);
    const first = gatewayFake();
    await qaStep({ pool: db.pool, gateway: first.gateway, llm, webBaseUrl: "https://web.test" }, apiId);
    await db.pool.query(`update apis set state = 'ownership_verified' where id = $1`, [apiId]);
    await db.pool.query(`update onboard_steps set status = 'running' where api_id = $1 and step = 'qa'`, [apiId]);
    const second = gatewayFake();
    await qaStep({ pool: db.pool, gateway: second.gateway, llm, webBaseUrl: "https://web.test" }, apiId);
    expect(second.preview).not.toHaveBeenCalled();
    expect((await db.pool.query(`select count(*)::int as n from rules r join operations o on o.id = r.operation_id where o.api_id = $1`, [apiId])).rows[0].n).toBe(1);
  });

  it("does not build a rule when a wrong request looks like a right one (rule too loose)", async () => {
    const apiId = await seedApi(db.pool, { state: "ownership_verified" });
    await seedOperation(db.pool, apiId);
    const preview = vi.fn(async () => json(200, { symbol: "ADA", price: 0.31 }));
    expect(await qaStep({ pool: db.pool, gateway: { preview } as GatewayClient, llm, webBaseUrl: "https://web.test" }, apiId)).toBe("failed");
    expect((await db.pool.query(`select state from apis where id = $1`, [apiId])).rows[0].state).toBe("ownership_verified");
    expect((await messagesFor(db.pool, apiId)).at(-1)?.body).toMatch(/can't tell them apart/);
  });

  it("a refused test call (401) fails for good and links the review page, where the key form is", async () => {
    const apiId = await seedApi(db.pool, { state: "ownership_verified" });
    await seedOperation(db.pool, apiId);
    const preview = vi.fn(async () => json(401, { error: "missing api key" }));
    expect(await qaStep({ pool: db.pool, gateway: { preview } as GatewayClient, llm, webBaseUrl: "https://web.test" }, apiId)).toBe("failed");
    expect((await messagesFor(db.pool, apiId)).at(-1)?.body)
      .toMatch(new RegExp(`refused \\(HTTP 401\\)\\. If your API needs a key, add it on the review page\\. The test calls then run again\\. Review page: https://web\\.test/apis/${apiId}/review$`));
  });
});

const apiId8 = () => Math.random().toString(36).slice(2, 10);

describe("qaStep for a text answer with no header line (status-only)", () => {
  const text = (status: number, body: string): PreviewResult => ({ status, contentType: "text/plain", body, latencyMs: 5 });
  const run = async (answer: (symbol: string) => string, sokosumi = false) => {
    const apiId = await seedApi(db.pool, { state: "ownership_verified", ...(sokosumi ? { sokosumiTaskId: `task_${apiId8()}` } : {}) });
    await seedOperation(db.pool, apiId);
    const preview = vi.fn(async (_a: string, _o: string, i: Record<string, unknown>) =>
      i.symbol === INVALID_STRING ? text(404, "Unknown symbol") : text(200, answer(String(i.symbol))));
    expect(await qaStep({ pool: db.pool, gateway: { preview } as GatewayClient, llm, webBaseUrl: "https://web.test" }, apiId)).toBe("ran");
    return { apiId, preview };
  };

  it("stores the suggested phrase and asks the seller to confirm it before publishing", async () => {
    const { apiId } = await run((s) => `Price of ${s}: 1 USD`, true);
    // The different good answers too, so the review page can check a phrase the seller types against them.
    const output = (await getStep(db.pool, apiId, "qa"))?.output;
    expect(output).toMatchObject({ suggestedPhrases: { getPrice: "Price of" } });
    expect(output?.goodAnswers).toEqual({ getPrice: [{ body: "Price of ADA: 1 USD", complete: true }, { body: "Price of BTC: 1 USD", complete: true }] });
    const body = (await messagesFor(db.pool, apiId)).at(-1)?.body ?? "";
    expect(body).toContain('This is a status-only promise: it does not check the content. Before you publish, confirm the phrase "Price of" on the review page or type another. Every good answer must contain it, so it can\'t be a date, a version or a count. Suggested price:');
    // The rule itself is unchanged: the seller confirms the phrase on the review page, which writes a new version.
    expect((await db.pool.query(`select count(*)::int as n from rules r join operations o on o.id = r.operation_id where o.api_id = $1`, [apiId])).rows[0].n).toBe(1);
  });

  it("with no suggestion, says a phrase is required before publishing and how to pick one", async () => {
    const { apiId } = await run((s) => (s === "ADA" ? "0.31" : "61000"));
    expect((await getStep(db.pool, apiId, "qa"))?.output).toMatchObject({ suggestedPhrases: {} });
    expect((await messagesFor(db.pool, apiId)).at(-1)?.body).toContain(
      "This promise only checks the status, so it needs a phrase before you can publish. Add one on the review page: a word or label every good answer contains, like Price or Symbol. Capital letters don't matter. Review the price and publish:",
    );
  });

  it("keeps a saved suggestion when a re-run reuses the rule", async () => {
    const { apiId } = await run((s) => `Price of ${s}: 1 USD`);
    await db.pool.query(`update apis set state = 'ownership_verified' where id = $1`, [apiId]);
    await db.pool.query(`update onboard_steps set status = 'running' where api_id = $1 and step = 'qa'`, [apiId]);
    const preview = vi.fn();
    await qaStep({ pool: db.pool, gateway: { preview } as unknown as GatewayClient, llm, webBaseUrl: "https://web.test" }, apiId);
    expect(preview).not.toHaveBeenCalled();
    expect((await getStep(db.pool, apiId, "qa"))?.output).toMatchObject({ suggestedPhrases: { getPrice: "Price of" }, goodAnswers: { getPrice: expect.any(Array) } });
  });
});

describe("phraseLines", () => {
  const answer = (contentType: string, body: string) => ({ status: 200, contentType, body, latencyMs: 1 });
  const statusOnly = inferRuleFromResponses([answer("text/plain", "1.5")]);
  const csv = withRequiredPhrase(inferRuleFromResponses([answer("text/csv", "a,b\n1,2\n"), answer("text/csv", "a,b\n3,4\n")]), "a,b");
  const json = inferRuleFromResponses([answer("application/json", '{"price":1}')]);

  it("asks only about status-only text promises, naming the endpoint when there are several", () => {
    expect(phraseLines([{ opId: "a", rule: csv }, { opId: "b", rule: json }], {})).toEqual([]);
    expect(phraseLines([{ opId: "a", rule: statusOnly }, { opId: "b", rule: csv }, { opId: "c", rule: statusOnly }], { a: 'say "hi"' })).toEqual([
      'For a, confirm the phrase "say \\"hi\\"" on the review page or type another. Every good answer must contain it, so it can\'t be a date, a version or a count.',
      "The promise for c only checks the status, so it needs a phrase before you can publish. Add one on the review page: a word or label every good answer contains, like Price or Symbol. Capital letters don't matter.",
    ]);
  });
});

describe("qaSummaryLine", () => {
  it("claims a rejected wrong request only for endpoints where one was actually tried", () => {
    expect(qaSummaryLine([{ opId: "a", calls: 6, badInput: "rejected" }])).toBe("Test calls done: 6 calls across 1 endpoint(s) all passed and a wrong request was correctly rejected.");
    expect(qaSummaryLine([{ opId: "a", calls: 5, badInput: "skipped" }])).toBe("Test calls done: 5 calls across 1 endpoint(s) all passed.");
    expect(qaSummaryLine([{ opId: "a", calls: 6, badInput: "rejected" }, { opId: "b", calls: 0, badInput: "reused" }]))
      .toBe("Test calls done: 6 calls across 2 endpoint(s) all passed, and a wrong request was correctly rejected on 1 of 2 endpoints.");
  });
});
