import { describe, it, expect } from "vitest";
import { USDM_PREPROD_ASSET } from "@x402/cardano";
import { answerBody, callOperation, choosePack, formatAnswer, formatMicros, parseCreditsRequired, NoAffordablePackError, GatewayProtocolError } from "../src/gatewayClient.js";
import { fakeGateway, json, GW, API, TOKEN, MASUMI_UNIT } from "./fakeGateway.js";

const call = (f: Parameters<typeof callOperation>[0], token?: string) =>
  callOperation(f, { gatewayUrl: GW, apiId: API, opId: "getPrice", query: { symbol: "ADA" }, token });

describe("gatewayClient", () => {
  it("parses credits_required and makes URLs absolute", async () => {
    const r = await call(fakeGateway().fetch);
    expect(r.kind).toBe("credits_required");
    if (r.kind !== "credits_required") return;
    expect(r.offer.packs[0].buyUrl).toBe(`${GW}/a/${API}/packs/pk_demo`);
    expect(r.offer.ruleUrl).toBe(`${GW}/r/sha256:abc`);
  });

  it("builds the op URL with the query string and bearer token", async () => {
    const gw = fakeGateway();
    await call(gw.fetch, TOKEN);
    expect(gw.state.urls[0]).toBe(`${GW}/a/${API}/x/getPrice?symbol=ADA`);
  });

  it("classifies 200 with X-Credits-Remaining", async () => {
    const r = await call(fakeGateway({ credits: 5 }).fetch, TOKEN);
    expect(r).toMatchObject({ kind: "ok", remaining: 4 });
  });

  it("classifies 422 with reasons and an optional remaining header", async () => {
    const r = await call(fakeGateway({ modes: ["fail"], remainingHeaderOnRefusal: true }).fetch, TOKEN);
    expect(r).toMatchObject({ kind: "promise_not_met", reasons: ["/usd is required"], remaining: 5 });
    const r2 = await call(fakeGateway({ modes: ["fail"] }).fetch, TOKEN);
    expect(r2).toMatchObject({ kind: "promise_not_met", remaining: null });
  });

  it("classifies 503, 401 pending, 401 invalid, 502", async () => {
    expect((await call(fakeGateway({ modes: ["down"] }).fetch, TOKEN)).kind).toBe("down");
    expect((await call(fakeGateway({ modes: ["pending"] }).fetch, TOKEN)).kind).toBe("token_pending");
    expect((await call(fakeGateway().fetch, "hk_wrong")).kind).toBe("invalid_token");
    expect((await call(fakeGateway({ modes: ["upstream_502"] }).fetch, TOKEN))).toMatchObject({ kind: "upstream_error", status: 502 });
  });

  it("classifies 503 upstream_rate_limited and 429 too_many_failed_calls as rate_limited", async () => {
    const r = await call(fakeGateway({ modes: ["rate_limited"], retryAfter: 12 }).fetch, TOKEN);
    expect(r).toEqual({ kind: "rate_limited", error: "upstream_rate_limited", retryAfter: 12, remaining: 5 });
    const r2 = await call(fakeGateway({ modes: ["too_many_failed"], retryAfter: 40 }).fetch, TOKEN);
    expect(r2).toEqual({ kind: "rate_limited", error: "too_many_failed_calls", retryAfter: 40, remaining: null });
    const r3 = await call(async () => json(503, { error: "upstream_rate_limited" }, { "Retry-After": "soon" }), TOKEN);
    expect(r3).toMatchObject({ kind: "rate_limited", retryAfter: null });
  });

  it("any other 503 is down, any other 429 is unexpected", async () => {
    expect(await call(async () => json(503, { error: "unavailable", message: "API is Down" }), TOKEN))
      .toEqual({ kind: "down", message: "API is Down" });
    expect(await call(async () => json(429, { error: "slow_down" }), TOKEN)).toMatchObject({ kind: "unexpected", status: 429 });
  });

  it("classifies 400 as bad input", async () => {
    const r = await call(async () => json(400, { error: "invalid_input", message: "symbol must be one of ADA" }));
    expect(r).toEqual({ kind: "bad_input", message: "symbol must be one of ADA" });
  });

  it("rejects a 402 that is not credits_required", () => {
    expect(() => parseCreditsRequired({ x402Version: 2, accepts: [] }, GW)).toThrow(GatewayProtocolError);
  });

  it("choosePack picks the cheapest per call within the cap", () => {
    const offer = parseCreditsRequired({
      error: "credits_required", ruleHash: "h", ruleUrl: "/r/h",
      packs: [
        { packId: "small", calls: 10, price: "1000000", asset: USDM_PREPROD_ASSET, buyUrl: "/a/x/packs/small" },
        { packId: "big", calls: 100, price: "2000000", asset: USDM_PREPROD_ASSET, buyUrl: "/a/x/packs/big" },
        { packId: "huge", calls: 1000, price: "9000000", asset: USDM_PREPROD_ASSET, buyUrl: "/a/x/packs/huge" },
      ],
    }, GW);
    expect(choosePack(offer, 5_000_000n).packId).toBe("big");
  });

  it("choosePack refuses a pack priced in the escrow unit (two-token mix-up)", () => {
    const offer = parseCreditsRequired({
      error: "credits_required", ruleHash: "h", ruleUrl: "/r/h",
      packs: [{ packId: "pk", calls: 100, price: "2000000", asset: MASUMI_UNIT, buyUrl: "/a/x/packs/pk" }],
    }, GW);
    expect(() => choosePack(offer, 5_000_000n)).toThrow(NoAffordablePackError);
  });

  it("choosePack refuses packs above the spend cap", () => {
    const offer = parseCreditsRequired({
      error: "credits_required", ruleHash: "h", ruleUrl: "/r/h",
      packs: [{ packId: "pk", calls: 100, price: "6000000", asset: USDM_PREPROD_ASSET, buyUrl: "/a/x/packs/pk" }],
    }, GW);
    expect(() => choosePack(offer, 5_000_000n)).toThrow(/price ≤ 5000000/);
  });

  it("formats micros as tUSDM", () => {
    expect(formatMicros("2000000")).toBe("2");
    expect(formatMicros(1_250_000n)).toBe("1.25");
    expect(formatMicros("100")).toBe("0.0001");
  });

  it("returns text answers as text and never parses them as JSON", async () => {
    const csv = "symbol,usd\nADA,0.27\n";
    const r = await call(fakeGateway({ answer: { body: csv, contentType: "text/csv; charset=utf-8" } }).fetch, TOKEN);
    expect(r).toMatchObject({ kind: "ok", body: csv, contentType: "text/csv; charset=utf-8", remaining: 4 });
    // A plain text answer that happens to look like JSON stays text.
    const n = await call(fakeGateway({ answer: { body: "42", contentType: "text/plain" } }).fetch, TOKEN);
    expect(n).toMatchObject({ kind: "ok", body: "42" });
  });

  it("asks for JSON first but accepts text", async () => {
    let accept: string | null = null;
    await call(async (_u, init) => { accept = new Headers(init?.headers).get("accept"); return json(200, {}); }, TOKEN);
    expect(accept).toBe("application/json, text/*;q=0.9, */*;q=0.8");
  });

  it("answerBody parses JSON media types, keeps bad JSON as text, and keeps other types as text", () => {
    expect(answerBody('{"a":1}', "application/json; charset=utf-8")).toEqual({ a: 1 });
    expect(answerBody('{"a":1}', "application/problem+json")).toEqual({ a: 1 });
    expect(answerBody('{"a":1}', null)).toEqual({ a: 1 });
    expect(answerBody("not json", "application/json")).toBe("not json");
    expect(answerBody("<a>1</a>", "application/xml")).toBe("<a>1</a>");
    expect(answerBody('{"a":1}', "text/plain")).toBe('{"a":1}');
  });

  it("formatAnswer prints text as it came and JSON on one line", () => {
    expect(formatAnswer({ a: 1 })).toBe('{"a":1}');
    expect(formatAnswer("ok")).toBe("ok");
    expect(formatAnswer("a,b\n1,2")).toBe("\na,b\n1,2");
    expect(formatAnswer("x".repeat(10), 4)).toBe("xxxx... (6 more chars)");
    expect(formatAnswer(undefined)).toBe("undefined");
  });
});
