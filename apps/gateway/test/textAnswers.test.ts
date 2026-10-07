import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { inferRuleFromResponses, outputHash, ruleHash, withRequiredPhrase } from "@hirakumi/core";
import { JobRunner } from "../src/jobs";
import { Monitor } from "../src/monitor";
import { insertActiveToken, makeHarness, type Harness } from "./helpers";

// An API without JSON: GET /prices.csv answers CSV. The rule is inferred the way the coworker's QA infers it, with the
// phrase the seller confirmed before publishing.
const CSV = "symbol,price\r\nADA,0.42\r\nBTC,60000\r\n";
const inferred = inferRuleFromResponses([
  { status: 200, contentType: "text/csv; charset=utf-8", body: CSV, latencyMs: 1 },
  { status: 200, contentType: "text/csv", body: "symbol,price\nETH,3000\n", latencyMs: 1 },
]);
const rule = withRequiredPhrase(inferred, "symbol,price");

let h: Harness;
const internal = { authorization: "Bearer internal-test-token-0123456789" };
beforeEach(async () => {
  h = await makeHarness();
  await h.sql`update operations set path = '/prices.csv' where id = ${h.seeded.operationId}`;
  await h.sql`update rules set definition = ${h.sql.json(rule as never)}, hash = ${ruleHash(rule)},
              plain_english = 'A CSV answer that contains symbol,price.' where id = ${h.seeded.ruleId}`;
  h.stub.setFile("/prices.csv", CSV, { contentType: "text/csv; charset=utf-8" });
});
afterEach(async () => { await h.close(); });

describe("an API that answers CSV", () => {
  it("the inferred rule is a text rule for text/csv", () => {
    expect(inferred).toMatchObject({ contentType: "text/csv", schema: { type: "string", minLength: 1, pattern: "\\S", not: { pattern: expect.any(String) } } });
  });

  it("an Excel-style CSV with a BOM is charged and returned without it, hashed as the buyer's res.text() reads it", async () => {
    h.stub.setFile("/prices.csv", Buffer.from(`\uFEFF${CSV}`), { contentType: "text/csv" });
    const { token, id } = await insertActiveToken(h.sql, h.seeded, 3);
    const r = await request(h.app).get(`/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`).set("authorization", `Bearer ${token}`).buffer(true);
    expect(r.status).toBe(200);
    expect(r.headers["x-credits-remaining"]).toBe("2");
    const raw = Buffer.from(r.text);
    expect(raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
    const buyerText = await new Response(raw).text();
    expect(buyerText).toBe(CSV);
    const receipts = await request(h.app).get(`/a/${h.seeded.apiId}/receipts`).set("authorization", `Bearer ${token}`);
    expect(receipts.body.calls[0]).toMatchObject({ verdict: "pass", charged: true, outputHash: outputHash(id, buyerText) });
  });

  it("a paid answer and a preview carry nosniff and a sandbox CSP, so a seller's body can't run as a page", async () => {
    const { token } = await insertActiveToken(h.sql, h.seeded, 3);
    const paid = await request(h.app).get(`/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`).set("authorization", `Bearer ${token}`);
    const preview = await request(h.app).post(`/internal/preview/${h.seeded.apiId}/getPrice`).set(internal).send({ input: { symbol: "ADA" } });
    for (const r of [paid, preview]) {
      expect(r.status).toBe(200);
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["content-security-policy"]).toBe("sandbox; default-src 'none'");
    }
  });

  it("a short error text sent as CSV with 200 lacks the phrase and breaks the promise: 422 and no credit used", async () => {
    for (const body of ["Rate limit exceeded", "404 Not Found\n", "<h1>Service Unavailable</h1>"]) {
      h.stub.setFile("/prices.csv", body, { contentType: "text/csv" });
      const { token } = await insertActiveToken(h.sql, h.seeded, 3);
      const r = await request(h.app).get(`/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`).set("authorization", `Bearer ${token}`);
      expect(r.status, body).toBe(422);
      expect(r.body.reasons, body).toContain('/ does not contain "symbol,price"');
      expect(r.headers["x-credits-remaining"]).toBe("3");
    }
  });

  it("a Latin-1 CSV is read in its charset and passed on as UTF-8", async () => {
    const latin = "symbol,price\r\nCAFÉ,1\r\n";
    h.stub.setFile("/prices.csv", Buffer.from(latin, "latin1"), { contentType: "text/csv; charset=ISO-8859-1" });
    const { token, id } = await insertActiveToken(h.sql, h.seeded, 3);
    const r = await request(h.app).get(`/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`).set("authorization", `Bearer ${token}`).buffer(true);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(r.text).toBe(latin);
    const receipts = await request(h.app).get(`/a/${h.seeded.apiId}/receipts`).set("authorization", `Bearer ${token}`);
    expect(receipts.body.calls[0]).toMatchObject({ verdict: "pass", outputHash: outputHash(id, latin) });
  });

  it("an HTML error page sent as text/csv with 200 breaks the promise", async () => {
    h.stub.setFile("/prices.csv", "<!DOCTYPE html><html><body>symbol,price\n</body></html>", { contentType: "text/csv" });
    const { token } = await insertActiveToken(h.sql, h.seeded, 3);
    const r = await request(h.app).get(`/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`).set("authorization", `Bearer ${token}`);
    expect(r.status).toBe(422);
    expect(r.headers["x-credits-remaining"]).toBe("3");
  });

  it("asks the upstream for CSV, not */*", async () => {
    // The stub records request headers on /price only, which answers JSON: the promise is broken, but the Accept is seen.
    await h.sql`update operations set path = '/price' where id = ${h.seeded.operationId}`;
    await request(h.app).post(`/internal/apis/${h.seeded.apiId}/reload`).set(internal).expect(200);
    const { token } = await insertActiveToken(h.sql, h.seeded, 3);
    await request(h.app).get(`/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`).set("authorization", `Bearer ${token}`).expect(422);
    expect(h.stub.lastHeaders()?.accept).toBe("text/csv, text/*;q=0.9");
  });

  it("a paid call returns the CSV byte for byte with its content type, and the receipt hashes that body", async () => {
    const { token, id } = await insertActiveToken(h.sql, h.seeded, 3);
    const r = await request(h.app).get(`/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`).set("authorization", `Bearer ${token}`).buffer(true);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(r.text).toBe(CSV);
    expect(r.headers["x-credits-remaining"]).toBe("2");
    const receipts = await request(h.app).get(`/a/${h.seeded.apiId}/receipts`).set("authorization", `Bearer ${token}`);
    expect(receipts.body.calls[0]).toMatchObject({ verdict: "pass", charged: true, ruleHash: ruleHash(rule), outputHash: outputHash(id, CSV) });
  });

  it("a CSV without the confirmed phrase breaks the promise: 422 and no credit used", async () => {
    h.stub.setFile("/prices.csv", "error,rate limited\n", { contentType: "text/csv" });
    const { token } = await insertActiveToken(h.sql, h.seeded, 3);
    const r = await request(h.app).get(`/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`).set("authorization", `Bearer ${token}`);
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("promise_not_met");
    expect(r.headers["x-credits-remaining"]).toBe("3");
  });

  it("preview shows the text body and the verdict", async () => {
    const r = await request(h.app).post(`/internal/preview/${h.seeded.apiId}/getPrice`).set(internal).send({ input: { symbol: "ADA" } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 200, contentType: "text/csv; charset=utf-8", body: CSV, verdict: { pass: true, reasons: [] } });
  });

  it("the monitor keeps it healthy, and an HTML error page takes it down", async () => {
    const m = new Monitor({ sql: h.sql, registry: h.registry, health: h.health, config: h.config });
    expect(await m.probeApi(h.seeded.apiId)).toBeNull();
    expect(h.health.get(h.seeded.apiId)?.health).toBe("healthy");
    h.stub.setFile("/prices.csv", "<html>oops</html>", { contentType: "text/html" });
    await m.probeApi(h.seeded.apiId);
    const t = await m.probeApi(h.seeded.apiId);
    expect(t).toMatchObject({ to: "down", reasons: [{ op: "getPrice", reason: "content type is text/html, expected text/csv" }] });
  });

  it("an escrow job stores the CSV as its output and submits the MIP-004 hash of it", async () => {
    const pid = "aabbccddeeff00112233";
    const runner = new JobRunner({ sql: h.sql, registry: h.registry, masumi: h.masumi, config: h.config });
    const started = await request(h.app).post(`/a/${h.seeded.apiId}/start_job`).send({ input_data: { symbol: "ADA" }, identifier_from_purchaser: pid });
    expect(started.status).toBe(200);
    h.masumi.state = "FundsLocked";
    await runner.tick();
    const status = await request(h.app).get(`/a/${h.seeded.apiId}/status`).query({ job_id: started.body.job_id });
    expect(status.body).toMatchObject({ status: "completed", output: CSV, result: CSV, output_hash: outputHash(pid, CSV) });
    expect(status.headers["x-content-type-options"]).toBe("nosniff");
    expect(status.headers["content-security-policy"]).toBe("sandbox; default-src 'none'");
    expect(h.masumi.submitted).toEqual([{ blockchainIdentifier: expect.any(String), resultHash: outputHash(pid, CSV) }]);
  });
});
