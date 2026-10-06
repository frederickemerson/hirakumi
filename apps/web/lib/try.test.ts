import { describe, expect, it } from "vitest";
import { buildGatewayCall, coerceInput, createRateLimiter, describeTryResult, fieldsFromSchema, parseTryTokens, registryLinks } from "./try";

describe("buildGatewayCall", () => {
  it("puts GET input in the query string", () => {
    const c = buildGatewayCall("https://gw.test/", "api_1", { opId: "getPrice", method: "get" }, { symbol: "ADA", n: 2 });
    expect(c.url).toBe("https://gw.test/a/api_1/x/getPrice?symbol=ADA&n=2");
    expect(c.init.method).toBe("GET");
    expect(c.init.body).toBeUndefined();
  });
  it("sends non-GET input as a JSON body", () => {
    const c = buildGatewayCall("https://gw.test", "api_1", { opId: "quote", method: "POST" }, { body: { a: 1 } });
    expect(c.url).toBe("https://gw.test/a/api_1/x/quote");
    expect(c.init.body).toBe('{"body":{"a":1}}');
    expect((c.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });
  it("adds the bearer token only when given", () => {
    const paid = buildGatewayCall("https://gw.test", "api_1", { opId: "o", method: "GET" }, {}, "tok");
    const free = buildGatewayCall("https://gw.test", "api_1", { opId: "o", method: "GET" }, {});
    expect((paid.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect((free.init.headers as Record<string, string>).authorization).toBeUndefined();
  });
  it("escapes ids in the path", () => {
    expect(buildGatewayCall("https://gw.test", "a/b", { opId: "x y", method: "GET" }, {}).url).toBe("https://gw.test/a/a%2Fb/x/x%20y");
  });
  it("skips empty and missing query values", () => {
    expect(buildGatewayCall("https://gw.test", "a", { opId: "o", method: "GET" }, { s: "", t: undefined, u: "1" }).url).toBe("https://gw.test/a/a/x/o?u=1");
  });
});

describe("describeTryResult", () => {
  it("200 means the promise was kept and a credit was used", () => {
    expect(describeTryResult(200, {}).kind).toBe("kept");
  });
  it("422 means the promise was not kept and nothing was charged", () => {
    const r = describeTryResult(422, { error: "promise_not_met", reasons: ["price is too old"] });
    expect(r.kind).toBe("not_kept");
    expect(r.reasons).toEqual(["price is too old"]);
  });
  it("402 is the payment offer an agent sees", () => {
    expect(describeTryResult(402, { accepts: [] }).kind).toBe("payment_required");
  });
  it("503 is down", () => {
    expect(describeTryResult(503, { error: "down" }).kind).toBe("down");
  });
  it("400 is bad input with reasons", () => {
    const r = describeTryResult(400, { error: "invalid_input", reasons: ["symbol is required"] });
    expect(r.kind).toBe("invalid_input");
    expect(r.reasons).toEqual(["symbol is required"]);
  });
  it("anything else is an error", () => {
    expect(describeTryResult(502, null).kind).toBe("error");
  });
});

describe("parseTryTokens", () => {
  it("reads a JSON map of apiId to token", () => {
    expect(parseTryTokens('{"api_1":"t1"}')).toEqual({ api_1: "t1" });
  });
  it("is empty for missing or bad config", () => {
    expect(parseTryTokens(undefined)).toEqual({});
    expect(parseTryTokens("not json")).toEqual({});
    expect(parseTryTokens('["x"]')).toEqual({});
    expect(parseTryTokens('{"a":1,"b":"ok"}')).toEqual({ b: "ok" });
  });
});

describe("createRateLimiter", () => {
  it("allows one call per window per key", () => {
    const allow = createRateLimiter(3000);
    expect(allow("ip1", 0)).toBe(true);
    expect(allow("ip1", 1000)).toBe(false);
    expect(allow("ip2", 1000)).toBe(true);
    expect(allow("ip1", 3000)).toBe(true);
  });
});

describe("registryLinks", () => {
  const id = "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b1045366ca66c83ac363d53190157962fbea7b5751c6940f81251914ab5000000";
  it("splits the agent identifier into policy and asset name and links the preprod explorer", () => {
    const r = registryLinks(id);
    expect(r?.policyId).toBe("67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b");
    expect(r?.explorerUrl).toBe(`https://preprod.cardanoscan.io/token/${id}`);
  });
  it("is null when the agent is not registered or the id is malformed", () => {
    expect(registryLinks(null)).toBeNull();
    expect(registryLinks("zz")).toBeNull();
  });
});

describe("fieldsFromSchema", () => {
  it("turns an input schema into form fields with options and examples", () => {
    const f = fieldsFromSchema({
      properties: {
        symbol: { type: "string", enum: ["ADA", "BTC"], description: "Ticker" },
        limit: { type: "integer", examples: [5] },
        body: { type: "object", examples: [{ a: 1 }] },
      },
      required: ["symbol"],
    });
    expect(f).toEqual([
      { name: "symbol", required: true, options: ["ADA", "BTC"], example: "ADA", description: "Ticker", json: false },
      { name: "limit", required: false, options: null, example: "5", description: null, json: false },
      { name: "body", required: false, options: null, example: '{"a":1}', description: null, json: true },
    ]);
  });
  it("handles a schema without properties", () => {
    expect(fieldsFromSchema({})).toEqual([]);
  });
});

describe("coerceInput", () => {
  it("parses JSON fields and drops empty values", () => {
    const fields = fieldsFromSchema({ properties: { body: { type: "object" }, s: { type: "string" }, e: { type: "string" } } });
    expect(coerceInput(fields, { body: '{"a":1}', s: "x", e: "" })).toEqual({ ok: true, input: { body: { a: 1 }, s: "x" } });
  });
  it("reports a JSON field that does not parse", () => {
    const fields = fieldsFromSchema({ properties: { body: { type: "object" } } });
    expect(coerceInput(fields, { body: "{oops" })).toEqual({ ok: false, error: "body must be valid JSON." });
  });
});
