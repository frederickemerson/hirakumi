import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createPool } from "../../coworker/src/db";
import type { GatewayClient, PreviewResult } from "../../coworker/src/gateway";
import { LlmOutputError, type StructuredCall } from "../../coworker/src/llm/claude";
import { qaStep } from "../../coworker/src/onboarding/qaStep";
import { getStep } from "../../coworker/src/steps";
import { statusOnlyRefusal } from "../../web/lib/answer-format";
import { closeSql, getSql } from "../../web/lib/db";
import { addRequiredPhrase, getSuggestedPhrases, listLatestRules } from "../../web/lib/repo/rules";
import { insertActiveToken, makeHarness, type Harness } from "./helpers";

/**
 * A text API from the test calls to a paid answer, with each app's own code where it can run here: the coworker's QA
 * suggests a phrase from the good answers and the wrong one, the web app reads that suggestion for the review page
 * and refuses to publish (the publish route's own check) until the seller saves a phrase, and the gateway then
 * refuses a 200 answer without that phrase and charges a good answer. The web functions run on the web app's own
 * connection.
 */
const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://hirakumi:hirakumi@localhost:5432/hirakumi";
const internal = { authorization: "Bearer internal-test-token-0123456789" };
const PHRASE = "spot price in US dollars:";
const ERROR_PAGE = "<!DOCTYPE html><html><head><title>500 Internal Server Error</title></head><body><p>unavailable</p></body></html>";

describe("publish gate contract: QA suggestion, web phrase and publish check, gateway verdict", () => {
  let h: Harness;
  let upstream: Server;
  let override: { status: number; body: string } | null = null;
  afterEach(async () => {
    await closeSql();
    delete process.env.DATABASE_URL;
    await new Promise<void>((done) => upstream.close(() => done()));
    await h.close();
  });

  it("a text listing can't publish without a phrase, and once it has one a 200 answer without it is never charged", async () => {
    // The seller's API: a plain-text quote for a known symbol, a 404 for anything else (QA's wrong request).
    upstream = createServer((req, res) => {
      const symbol = new URL(req.url ?? "/", "http://up").searchParams.get("symbol") ?? "";
      if (override) { res.writeHead(override.status, { "content-type": "text/plain" }); res.end(override.body); return; }
      if (!["ADA", "BTC"].includes(symbol)) { res.writeHead(404, { "content-type": "text/plain" }); res.end(`Unknown symbol ${symbol}`); return; }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`${symbol} ${PHRASE} ${symbol === "ADA" ? "0.35" : "60000"}\n`);
    });
    await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

    h = await makeHarness({ seed: { state: "ownership_verified" } });
    const { apiId, sellerId, operationId } = h.seeded;
    await h.sql`update apis set origin = ${origin} where id = ${apiId}`;
    await h.sql`delete from test_inputs where operation_id = ${operationId}`;
    await h.sql`delete from rules where operation_id = ${operationId}`;
    await h.sql`update operations set path = '/quote', input_schema = ${h.sql.json({
      type: "object", properties: { symbol: { type: "string", examples: ["ADA", "BTC"] } }, required: ["symbol"], additionalProperties: false,
    })} where id = ${operationId}`;

    // Coworker: QA through the gateway's preview route, with the fallback promise text (the model is unavailable).
    const gateway: GatewayClient = {
      async preview(id, opId, input) {
        const r = await request(h.app).post(`/internal/preview/${id}/${opId}`).set(internal).send({ input });
        if (r.status !== 200) throw new Error(`preview failed: HTTP ${r.status}`);
        return r.body as PreviewResult;
      },
    };
    const llm = (async () => { throw new LlmOutputError("no model in this test"); }) as StructuredCall;
    const pool = createPool(TEST_URL, h.db.schema);
    try {
      expect(await qaStep({ pool, gateway, llm, webBaseUrl: "https://web.test" }, apiId)).toBe("ran");
      expect((await getStep(pool, apiId, "qa"))?.output?.suggestedPhrases).toEqual({ getPrice: PHRASE });
    } finally {
      await pool.end();
    }
    const [v1] = await h.sql<{ plain_english: string }[]>`select plain_english from rules where operation_id = ${operationId} and version = 1`;
    expect(v1.plain_english).toMatch(/and not an HTML page\. This is a status-only promise/);

    // Web: the review page gets the suggestion, and publishing is refused while the promise only checks the status.
    const url = new URL(TEST_URL);
    url.searchParams.set("search_path", h.db.schema);
    process.env.DATABASE_URL = url.href;
    const sql = getSql();
    await h.sql`update apis set state = 'priced' where id = ${apiId}`;
    expect(await getSuggestedPhrases(sql, apiId)).toEqual({ [operationId]: PHRASE });
    const before = await listLatestRules(sql, apiId);
    expect(before.map((p) => p.statusOnly)).toEqual([true]);
    expect(statusOnlyRefusal(before)).toMatch(/^Add a phrase every good answer contains for GET \/quote before publishing\./);

    // The seller confirms the suggestion: a new rule version, and publishing is no longer refused.
    expect(await addRequiredPhrase(sql, { apiId, sellerId, operationId, phrase: PHRASE })).toMatchObject({ ok: true, version: 2 });
    const after = await listLatestRules(sql, apiId);
    expect(after).toMatchObject([{ version: 2, statusOnly: false, requiredPhrases: [PHRASE] }]);
    expect(after[0].plainEnglish).toMatch(/and not an HTML page\. Every good answer contains "spot price in US dollars:"\.$/);
    expect(statusOnlyRefusal(after)).toBeNull();

    // Published (registration is the coworker's, not run here). The gateway uses the latest rule.
    await h.sql`update apis set state = 'live' where id = ${apiId}`;
    await request(h.app).post(`/internal/apis/${apiId}/reload`).set(internal).expect(200);
    const { token } = await insertActiveToken(h.sql, h.seeded, 3);
    const paid = () => request(h.app).get(`/a/${apiId}/x/getPrice?symbol=ADA`).set("authorization", `Bearer ${token}`);

    // A 200 HTML error page and 200 answers without the phrase: refused, no credit used.
    for (const body of [ERROR_PAGE, `Error: feed down. ${"Retry in a minute. ".repeat(12)}`, "Back soon."]) {
      override = { status: 200, body };
      const r = await paid();
      expect(r.status, body).toBe(422);
      expect(r.headers["x-credits-remaining"], body).toBe("3");
    }
    override = null;
    const ok = await paid();
    expect(ok.status).toBe(200);
    expect(ok.text).toBe(`ADA ${PHRASE} 0.35\n`);
    expect(ok.headers["x-credits-remaining"]).toBe("2");
    const receipts = await request(h.app).get(`/a/${apiId}/receipts`).set("authorization", `Bearer ${token}`);
    expect(receipts.body.calls.map((c: { verdict: string; charged: boolean }) => [c.verdict, c.charged]))
      .toEqual(expect.arrayContaining([["fail", false], ["pass", true]]));
  });
});
