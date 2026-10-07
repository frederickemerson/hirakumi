import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inferRuleFromResponses, inferTextRule, withRequiredPhrase } from "@hirakumi/core";
import { getSql } from "@/lib/db";
import { setExposureFetchForTests } from "@/lib/exposure";
import { setGatewayForTests, type Gateway } from "@/lib/gateway";
import { addRequiredPhrase, getSuggestedPhrases } from "@/lib/repo/rules";
import type { Api, Seller } from "@/lib/types";
import { resetDb } from "@/test/db";
import { seedApi, seedOnboardStep, seedOperation, seedPack, seedRule, seedSeller, seedTestInput } from "@/test/factories";
import { cookieFor, ctx, jsonRequest } from "@/test/requests";
import { POST as pricing } from "./pricing/route";
import { POST as exposureCheck } from "./exposure/route";
import { POST as publish } from "./publish/route";

let seller: Seller;
let api: Api;
const reloadApi = vi.fn(async () => undefined);

async function setup(state: Api["state"]) {
  seller = await seedSeller();
  api = await seedApi(seller.id, state);
  const op = await seedOperation(api.id, { enabled: true });
  await seedRule(op.id);
}

function price(body: unknown, cookie = cookieFor(seller)) {
  return pricing(jsonRequest(`/api/apis/${api.id}/pricing`, { cookie, body }), ctx(api.id));
}
function pub(cookie = cookieFor(seller)) {
  return publish(jsonRequest(`/api/apis/${api.id}/publish`, { cookie, body: {} }), ctx(api.id));
}
const answerWithoutKey = vi.fn(async () => ({ status: 401, contentType: "application/json", body: '{"error":"missing key"}', latencyMs: 1 }));
const goodAnswer = () => ({ status: 200, contentType: "application/json", body: JSON.stringify({ price: 1, last_updated: new Date().toISOString() }), latencyMs: 1 });

async function state() {
  const [row] = await getSql()<{ state: string }[]>`select state from apis where id = ${api.id}`;
  return row.state;
}

describe("pricing and publish", () => {
  beforeEach(async () => {
    await resetDb();
    reloadApi.mockClear();
    answerWithoutKey.mockClear();
    setGatewayForTests({ checkChallenge: vi.fn(), reloadApi, getHealth: vi.fn(), getSettlement: vi.fn(async () => []) } as Gateway);
    // The leak check: the seller's API refuses calls without its key, unless a test says otherwise.
    setExposureFetchForTests(answerWithoutKey);
  });
  afterEach(() => {
    setGatewayForTests(null);
    setExposureFetchForTests(null);
  });

  it("stores 2.5 tUSDM as 2500000 micros and moves to priced", async () => {
    await setup("rule_built");
    const res = await price({ packCalls: "100", packPrice: "2.5", escrowPrice: "2" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "priced", pack: { calls: 100, priceMicros: "2500000", escrowPriceMicros: "2000000" } });
    const packs = await getSql()<{ priceMicros: string }[]>`select price_micros::text as price_micros from packs where api_id = ${api.id}`;
    expect(packs).toEqual([{ priceMicros: "2500000" }]);
    expect(await state()).toBe("priced");
    expect(reloadApi).toHaveBeenCalledWith(api.id);
  });

  it("re-saving the price updates the same pack", async () => {
    await setup("rule_built");
    await price({ packCalls: "100", packPrice: "2", escrowPrice: "2" });
    await price({ packCalls: "50", packPrice: "1.5", escrowPrice: "3" });
    const packs = await getSql()<{ calls: number }[]>`select calls from packs where api_id = ${api.id}`;
    expect(packs).toEqual([{ calls: 50 }]);
  });

  it("refuses a pack under 1 tUSDM in plain English", async () => {
    await setup("rule_built");
    const res = await price({ packCalls: "100", packPrice: "0.5", escrowPrice: "2" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "A pack must cost at least 1 tUSDM. Cardano can't move smaller token payments cheaply." });
  });

  it("explains a malformed amount", async () => {
    await setup("rule_built");
    const res = await price({ packCalls: "100", packPrice: "two", escrowPrice: "2" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/^Enter an amount like 2 or 2.50/);
  });

  it("still saves the price when the gateway reload fails", async () => {
    await setup("rule_built");
    reloadApi.mockRejectedValueOnce(new Error("down"));
    expect((await price({ packCalls: "100", packPrice: "2", escrowPrice: "2" })).status).toBe(200);
  });

  it("refuses pricing before the test calls finished", async () => {
    await setup("ownership_verified");
    expect((await price({ packCalls: "100", packPrice: "2", escrowPrice: "2" })).status).toBe(409);
  });

  it("refuses pricing when an enabled endpoint has no promise yet", async () => {
    await setup("rule_built");
    await seedOperation(api.id, { opId: "getHistory", path: "/history", enabled: true });
    const res = await price({ packCalls: "100", packPrice: "2", escrowPrice: "2" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "The test calls haven't finished for every endpoint yet. Wait a moment and reload." });
  });

  it("returns 404 for another seller's API", async () => {
    await setup("rule_built");
    const intruder = await seedSeller();
    expect((await price({ packCalls: "100", packPrice: "2", escrowPrice: "2" }, cookieFor(intruder))).status).toBe(404);
  });

  it("publish before pricing is refused", async () => {
    await setup("rule_built");
    expect((await pub()).status).toBe(409);
    expect(await state()).toBe("rule_built");
  });

  it("publishes a priced API into registering", async () => {
    await setup("priced");
    await seedPack(api.id);
    const res = await pub();
    expect(res.status).toBe(200);
    expect(await state()).toBe("registering");
  });

  it("refuses to publish an API anyone can call for free without its key, naming the URL, and stores the result", async () => {
    await setup("priced");
    await seedPack(api.id);
    const [op] = await getSql()<{ id: string }[]>`select id from operations where api_id = ${api.id}`;
    await seedTestInput(op.id, { symbol: "ADA" });
    answerWithoutKey.mockResolvedValueOnce(goodAnswer());
    const res = await pub();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: `Anyone can call this API for free at https://price.example.dev${api.pathPrefix}/price?symbol=ADA, so nobody would pay through Hirakumi. ` +
        "Make your API require a key and add it on this page.",
    });
    expect(await state()).toBe("priced");
    expect(reloadApi).not.toHaveBeenCalled();
    const [row] = await getSql()<{ exposure: string }[]>`select exposure from apis where id = ${api.id}`;
    expect(row.exposure).toBe("open");
  });

  it("runs the check again at publish time: a stored 'protected' does not let an open API through", async () => {
    await setup("priced");
    await seedPack(api.id);
    await getSql()`update apis set exposure = 'protected', exposure_checked_at = now() where id = ${api.id}`;
    answerWithoutKey.mockResolvedValueOnce(goodAnswer());
    expect((await pub()).status).toBe(409);
    expect(await state()).toBe("priced");
  });

  it("a check that can't reach the API blocks publishing with a retry message, never passing silently", async () => {
    await setup("priced");
    await seedPack(api.id);
    answerWithoutKey.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const res = await pub();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      `We couldn't confirm that your API refuses calls without its key, so it can't be published yet. ` +
        `GET https://price.example.dev${api.pathPrefix}/price could not be reached. Check again in a minute.`,
    );
    expect(await state()).toBe("priced");
    // The retry: once the API refuses calls without its key, publishing goes through.
    expect((await pub()).status).toBe(200);
    expect(await state()).toBe("registering");
    const [row] = await getSql()<{ exposure: string }[]>`select exposure from apis where id = ${api.id}`;
    expect(row.exposure).toBe("protected");
  });

  it("\"Check again\" runs the check and returns the result with what blocks publishing", async () => {
    await setup("priced");
    answerWithoutKey.mockResolvedValueOnce(goodAnswer());
    const check = (cookie = cookieFor(seller)) =>
      exposureCheck(jsonRequest(`/api/apis/${api.id}/exposure`, { cookie, body: {} }), ctx(api.id));
    const open = await check();
    expect(open.status).toBe(200);
    expect(await open.json()).toMatchObject({ exposure: "open", message: expect.stringMatching(/^Anyone can call this API for free at /) });
    const fixed = await check();
    expect(await fixed.json()).toMatchObject({ exposure: "protected", message: null, endpoints: [{ exposure: "protected" }] });
    expect((await check(cookieFor(await seedSeller()))).status).toBe(404);
  });

  it("\"Check again\" is refused before the test calls finished", async () => {
    await setup("ownership_verified");
    const res = await exposureCheck(jsonRequest(`/api/apis/${api.id}/exposure`, { cookie: cookieFor(seller), body: {} }), ctx(api.id));
    expect(res.status).toBe(409);
    expect(answerWithoutKey).not.toHaveBeenCalled();
  });

  it("a live listing is not unpublished by an open result", async () => {
    await setup("live");
    answerWithoutKey.mockResolvedValueOnce(goodAnswer());
    const res = await exposureCheck(jsonRequest(`/api/apis/${api.id}/exposure`, { cookie: cookieFor(seller), body: {} }), ctx(api.id));
    expect(((await res.json()) as { exposure: string }).exposure).toBe("open");
    expect(await state()).toBe("live");
  });

  it("two concurrent publishes: exactly one succeeds", async () => {
    await setup("priced");
    await seedPack(api.id);
    const statuses = (await Promise.all([pub(), pub()])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
  });

  it("refuses to publish while a text promise only checks the status, naming the endpoint", async () => {
    await setup("priced");
    await seedPack(api.id);
    const text = await seedOperation(api.id, { opId: "getQuote", path: "/quote", enabled: true });
    const statusOnly = inferTextRule("text/plain", ["BTC 64000", "ETH 3100"]);
    await seedRule(text.id, { definition: statusOnly });
    const res = await pub();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Add a phrase every good answer contains for GET /quote before publishing. Without a phrase, an error page sent with status 200 could count as a good answer.",
    });
    expect(await state()).toBe("priced");

    // A later version with a phrase is the promise from now on, so publishing goes through.
    await seedRule(text.id, { definition: withRequiredPhrase(statusOnly, "USD"), version: 2 });
    expect((await pub()).status).toBe(200);
    expect(await state()).toBe("registering");
  });

  it.each([
    ["a CSV with an error column", "text/csv", ["error,count\ntimeout,3\n", "error,count\ndns,1\n"], "error,count"],
    ["an XML document with an <errors> root", "application/xml", ["<errors><item>disk full</item></errors>", "<errors><item>cpu hot</item></errors>"], "<errors>"],
    ["a log API", "text/plain", ["2026-10-07T12:00:01Z ERROR db timeout\n", "2026-10-07T12:00:02Z FATAL out of memory\n"], "2026-10-07T"],
    ["a news line", "text/plain", ["Fatal accidents fell 3%", "Fatal accidents rose 1%"], "Fatal accidents"],
  ])("publishes %s once the seller confirms a phrase its answers contain", async (_name, ct, good, phrase) => {
    await setup("priced");
    await seedPack(api.id);
    const text = await seedOperation(api.id, { opId: "getFeed", path: "/feed", enabled: true });
    const answer = (body: string, status = 200) => ({ status, contentType: ct, body, latencyMs: 1 });
    await seedRule(text.id, { definition: inferRuleFromResponses(good.map((b) => answer(b)), answer("unknown input", 404)) });
    await seedOnboardStep(api.id, "qa", "done", { goodAnswers: { getFeed: good.map((body) => ({ body, complete: true })) } });
    expect((await pub()).status).toBe(409);
    expect(await addRequiredPhrase(getSql(), { apiId: api.id, sellerId: seller.id, operationId: text.id, phrase })).toMatchObject({ ok: true, version: 2 });
    expect((await pub()).status).toBe(200);
    expect(await state()).toBe("registering");
  });

  it("a disabled endpoint's status-only promise doesn't block publishing", async () => {
    await setup("priced");
    await seedPack(api.id);
    const off = await seedOperation(api.id, { opId: "getQuote", path: "/quote", enabled: false });
    await seedRule(off.id, { definition: inferTextRule("text/plain", ["BTC 64000", "ETH 3100"]) });
    expect((await pub()).status).toBe(200);
  });

  it("reads QA's suggested phrases by operation, skipping odd values", async () => {
    await setup("rule_built");
    const quote = await seedOperation(api.id, { opId: "getQuote", path: "/quote", enabled: true });
    await seedOperation(api.id, { opId: "getOdd", path: "/odd", enabled: true });
    await seedOnboardStep(api.id, "qa", "done", { suggestedPhrases: { getQuote: " Last price: ", getOdd: "two\nlines", missing: "x" } });
    expect(await getSuggestedPhrases(getSql(), api.id)).toEqual({ [quote.id]: "Last price:" });
    await getSql()`delete from onboard_steps where api_id = ${api.id}`;
    expect(await getSuggestedPhrases(getSql(), api.id)).toEqual({});
  });
});
