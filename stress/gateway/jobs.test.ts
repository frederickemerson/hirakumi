// MIP-003 escrow jobs with a hostile seller answer: a text answer holding a raw NUL byte (Postgres text can't
// store it). Safe behaviour: the job ends in a final state (completed or failed and refunded), never stuck running.
import { afterEach, describe, expect, it } from "vitest";
import { inferRuleFromResponses, ruleHash, withRequiredPhrase } from "@hirakumi/core";
import { JobRunner } from "../../apps/gateway/src/jobs";
import { makeHarness, serve, type Harness } from "./kit";

const CSV = "symbol,price\r\nADA,0.42\r\n";
const rule = withRequiredPhrase(inferRuleFromResponses([
  { status: 200, contentType: "text/csv", body: CSV, latencyMs: 1 },
  { status: 200, contentType: "text/csv", body: "symbol,price\nETH,3000\n", latencyMs: 1 },
]), "symbol,price");

let h: Harness;
afterEach(async () => { await h?.close(); });

describe("escrow jobs and unstorable answers", () => {
  it("a passing CSV answer with a NUL byte: the job reaches a final state", async () => {
    h = await makeHarness();
    await h.sql`update operations set path = '/prices.csv' where id = ${h.seeded.operationId}`;
    await h.sql`update rules set definition = ${h.sql.json(rule as never)}, hash = ${ruleHash(rule)} where id = ${h.seeded.ruleId}`;
    h.registry.invalidate(h.seeded.apiId);
    h.stub.setFile("/prices.csv", Buffer.from(`${CSV}ADA\u0000,1\r\n`), { contentType: "text/csv" });
    const srv = await serve(h.app);
    const r = await srv.req(`/a/${h.seeded.apiId}/start_job`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier_from_purchaser: "aabbccddeeff0011", input_data: { symbol: "ADA" } }),
    });
    expect(r.status).toBe(200);
    h.masumi.state = "FundsLocked";
    const runner = new JobRunner({ sql: h.sql, registry: h.registry, masumi: h.masumi, config: h.config });
    await runner.tick();
    await runner.tick();
    const status = await srv.req(`/a/${h.seeded.apiId}/status?job_id=${r.json.job_id}`);
    await srv.close();
    expect(["completed", "failed"]).toContain(status.json.status);
  });
});
