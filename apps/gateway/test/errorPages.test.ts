import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { encodePaymentSignatureHeader, decodePaymentRequiredHeader } from "@x402/core/http";
import { newReceiptKey } from "@hirakumi/escrow";
import { getChannel } from "@hirakumi/db";
import { inferRuleFromResponses, ruleHash, sha256Hex, withRequiredPhrase, type RuleDefinition } from "@hirakumi/core";
import type { PackEscrowConfig } from "../src/config";
import { JobRunner } from "../src/jobs";
import { Monitor } from "../src/monitor";
import { FakeEscrowChain } from "./fakeChain";
import { fakeTxHash, insertActiveToken, makeHarness, type Harness } from "./helpers";

// A plain-text listing whose seller required the phrase "price". Every error page below contains "price" too, so only
// the error checks (core errorBodyNot) refuse them.
const GOOD = "ADA price 0.35 USD\n";
const TEXT_RULE = withRequiredPhrase(inferRuleFromResponses([{ status: 200, contentType: "text/plain", body: GOOD, latencyMs: 1 }]), "price");
const ERROR_PAGES = [
  `Error: price feed unavailable. ${"The upstream venue did not answer in time, retry later. ".repeat(4)}`,
  `Rate limit exceeded for /price. ${"You sent too many requests this minute, slow down and retry. ".repeat(4)}`,
  'Traceback (most recent call last):\n  File "/app/price.py", line 9, in get_price\n    return PRICES[symbol]\nKeyError: \'ADA\'\n',
  "ADA price\njava.lang.NullPointerException\n\tat com.example.price.PriceService.lookup(PriceService.java:27)\n",
  '{"timestamp":"2026-10-07T12:00:00Z","status":500,"error":"Internal Server Error","path":"/price"}',
  `HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\n\r\nprice service is down ${"please retry ".repeat(20)}`,
  `<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body><h1>price</h1>${"<p>nginx</p>".repeat(20)}</body></html>`,
];

let h: Harness;
afterEach(async () => { await h?.close(); });

async function useRule(def: RuleDefinition, path: string) {
  await h.sql`update operations set path = ${path} where id = ${h.seeded.operationId}`;
  await h.sql`update rules set definition = ${h.sql.json(def as never)}, hash = ${ruleHash(def)} where id = ${h.seeded.ruleId}`;
}
const paid = (token: string) => request(h.app).get(`/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`).set("authorization", `Bearer ${token}`);

describe("a 200 error page never keeps the promise", () => {
  it("credits: 422, no credit used, and the receipt says fail and not charged", async () => {
    h = await makeHarness();
    await useRule(TEXT_RULE, "/price.txt");
    for (const body of ERROR_PAGES) {
      h.stub.setFile("/price.txt", body, { contentType: "text/plain" });
      const { token } = await insertActiveToken(h.sql, h.seeded, 3);
      const r = await paid(token);
      expect(r.status, body).toBe(422);
      expect(r.body.reasons, body).toEqual(["/ looks like an error response"]);
      expect(r.headers["x-credits-remaining"], body).toBe("3");
      const receipts = await request(h.app).get(`/a/${h.seeded.apiId}/receipts`).set("authorization", `Bearer ${token}`);
      expect(receipts.body.calls[0], body).toMatchObject({ verdict: "fail", charged: false });
    }
    h.stub.setFile("/price.txt", GOOD, { contentType: "text/plain" });
    const { token } = await insertActiveToken(h.sql, h.seeded, 3);
    const ok = await paid(token);
    expect(ok.status).toBe(200);
    expect(ok.headers["x-credits-remaining"]).toBe("2");
  });

  it("a JSON listing refuses a 200 answer with an error key no good answer had", async () => {
    h = await makeHarness();
    const json = inferRuleFromResponses([{ status: 200, contentType: "application/json", body: '{"symbol":"ADA","price":0.35}', latencyMs: 1 }]);
    await useRule(json, "/price.json");
    h.stub.setFile("/price.json", '{"symbol":"ADA","price":0.35,"error":"stale price, venue offline"}', { contentType: "application/json" });
    const { token } = await insertActiveToken(h.sql, h.seeded, 3);
    const r = await paid(token);
    expect(r.status).toBe(422);
    expect(r.headers["x-credits-remaining"]).toBe("3");
  });

  it("MIP-003: the job fails and no result is submitted", async () => {
    h = await makeHarness();
    await useRule(TEXT_RULE, "/price.txt");
    h.stub.setFile("/price.txt", ERROR_PAGES[2]!, { contentType: "text/plain" });
    const runner = new JobRunner({ sql: h.sql, registry: h.registry, masumi: h.masumi, config: h.config });
    const started = await request(h.app).post(`/a/${h.seeded.apiId}/start_job`).send({ input_data: { symbol: "ADA" }, identifier_from_purchaser: "aabbccddeeff00112233" });
    expect(started.status).toBe(200);
    h.masumi.state = "FundsLocked";
    await runner.tick();
    const status = await request(h.app).get(`/a/${h.seeded.apiId}/status`).query({ job_id: started.body.job_id });
    expect(status.body.status).toBe("failed");
    expect(h.masumi.submitted).toEqual([]);
  });

  it("the monitor takes the API down, and preview shows the failed verdict", async () => {
    h = await makeHarness();
    await useRule(TEXT_RULE, "/price.txt");
    h.stub.setFile("/price.txt", ERROR_PAGES[0]!, { contentType: "text/plain" });
    const m = new Monitor({ sql: h.sql, registry: h.registry, health: h.health, config: h.config });
    await m.probeApi(h.seeded.apiId);
    expect(await m.probeApi(h.seeded.apiId)).toMatchObject({ to: "down", reasons: [{ op: "getPrice", reason: "/ looks like an error response" }] });
    const preview = await request(h.app).post(`/internal/preview/${h.seeded.apiId}/getPrice`)
      .set({ authorization: "Bearer internal-test-token-0123456789" }).send({ input: { symbol: "ADA" } });
    expect(preview.body.verdict).toEqual({ pass: false, reasons: ["/ looks like an error response"] });
  });
});

const ESCROW: PackEscrowConfig = {
  feeAddress: "addr_test1vrl0alh7lml0alh7lml0alh7lml0alh7lml0alh7lml0alsu6gx0s", feeBps: 300, closerVkh: "c1".repeat(28),
  contestPeriodMs: 180_000, closeFeeBudgetLovelace: 700_000, operatorMnemonic: null, leaseSeconds: 30, raiseMarginMs: 60_000,
};
const BUYER = "addr_test1qzcmrvd3kxcmrvd3kxcmrvd3kxcmrvd3kxcmrvd3kxcmrvd4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kk6sfs370w";

describe("escrow pack: a 200 error page asks for no IOU and does not count", () => {
  it("422 without Sign-Next, and the channel's passes stay at 0", async () => {
    const chain = new FakeEscrowChain(true);
    h = await makeHarness({ config: { packMode: "escrow", packEscrow: ESCROW, upstreamTimeoutMs: 3_000 }, escrowChain: chain, facilitatorMethods: ["default", "script"] });
    await h.sql`update sellers set cardano_addr = ${"addr_test1vp09uhj7te09uhj7te09uhj7te09uhj7te09uhj7te09uhsgy423y"} where id = ${h.seeded.sellerId}`;
    await useRule(TEXT_RULE, "/price.txt");
    const key = newReceiptKey();
    const packPath = `/a/${h.seeded.apiId}/packs/${h.seeded.packId}`;
    const asBuyer = (r: request.Test) => r.set("x-hirakumi-receipt-key", key.publicKey).set("x-hirakumi-refund-address", BUYER);
    const unpaid = await asBuyer(request(h.app).post(packPath));
    const required = decodePaymentRequiredHeader(String(unpaid.headers["payment-required"]));
    const accepted = required.accepts[0]!;
    const transaction = "lock-error-pages";
    chain.putLock(fakeTxHash(transaction)!, String((accepted.extra as { datum: string }).datum));
    const header = encodePaymentSignatureHeader({ x402Version: required.x402Version, resource: required.resource, accepted, payload: { transaction, nonce: "n" } });
    const bought = await asBuyer(request(h.app).post(packPath).set("PAYMENT-SIGNATURE", header)).set("x-hirakumi-recovery", sha256Hex("secret"));
    expect(bought.status).toBe(200);
    const channelId = String((accepted.extra as { channelId: string }).channelId);
    for (const body of ERROR_PAGES) {
      h.stub.setFile("/price.txt", body, { contentType: "text/plain" });
      const r = await paid(bought.body.token);
      expect(r.status, body).toBe(422);
      expect(r.headers["x-hirakumi-sign-next"], body).toBeUndefined();
    }
    expect((await getChannel(h.sql, channelId))!.passes_served).toBe(0);
  });
});
