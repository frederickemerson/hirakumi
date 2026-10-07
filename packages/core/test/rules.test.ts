import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compileRule, inferRule, ruleHash, type RuleDefinition } from "../src/rules";
import type { UpstreamResult } from "../src/fetch";

const NOW = new Date("2026-10-06T12:00:00.000Z");
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

const priceRule: RuleDefinition = {
  version: 1,
  status: { min: 200, max: 299 },
  contentType: "application/json",
  schema: {
    type: "object",
    required: ["price", "symbol", "updatedAt"],
    properties: {
      price: { type: "number" },
      symbol: { type: "string" },
      updatedAt: { type: "string", maxAgeSeconds: 300 },
    },
  },
};
const res = (body: unknown, over: Partial<UpstreamResult> = {}): UpstreamResult => ({
  status: 200, contentType: "application/json; charset=utf-8",
  body: typeof body === "string" ? body : JSON.stringify(body), latencyMs: 5, ...over,
});
const fresh = { symbol: "ADA", price: 0.42, updatedAt: "2026-10-06T11:59:00.000Z" };

describe("ruleHash", () => {
  it("is sha256 over JCS and ignores key order", () => {
    const reordered = { schema: priceRule.schema, contentType: "application/json", version: 1, status: { max: 299, min: 200 } } as RuleDefinition;
    expect(ruleHash(priceRule)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ruleHash(reordered)).toBe(ruleHash(priceRule));
  });
});

describe("compileRule", () => {
  it("passes a response that keeps the promise", () => {
    expect(compileRule(priceRule).check(res(fresh))).toEqual({ pass: true, reasons: [] });
  });
  it("fails {} and names every missing field", () => {
    const v = compileRule(priceRule).check(res({}));
    expect(v.pass).toBe(false);
    expect(v.reasons).toHaveLength(3);
    expect(v.reasons).toEqual(expect.arrayContaining(["/price is missing", "/symbol is missing", "/updatedAt is missing"]));
  });
  it("fails stale data through maxAgeSeconds (ISO string)", () => {
    const v = compileRule(priceRule).check(res({ ...fresh, updatedAt: "2026-10-06T11:00:00.000Z" }));
    expect(v).toEqual({ pass: false, reasons: ["/updatedAt is older than 300s"] });
  });
  it("a timestamp from the future is not fresh (\"2099-…\", or epoch milliseconds read as seconds)", () => {
    const rule: RuleDefinition = { ...priceRule, schema: { type: "object", required: ["ts"], properties: { ts: { maxAgeSeconds: 60 } } } };
    const c = compileRule(rule);
    expect(c.check(res({ ts: "2099-01-01T00:00:00Z" })).reasons).toEqual(["/ts is in the future"]);
    expect(c.check(res({ ts: NOW.getTime() })).pass).toBe(false);
    expect(c.check(res({ ts: new Date(NOW.getTime() + 30_000).toISOString() })).pass).toBe(true); // clock skew up to 60 s is fine
  });
  it("maxAgeSeconds also accepts epoch seconds", () => {
    const rule: RuleDefinition = { ...priceRule, schema: { type: "object", required: ["ts"], properties: { ts: { type: "number", maxAgeSeconds: 60 } } } };
    const nowS = NOW.getTime() / 1000;
    expect(compileRule(rule).check(res({ ts: nowS - 30 })).pass).toBe(true);
    expect(compileRule(rule).check(res({ ts: nowS - 120 })).reasons).toEqual(["/ts is older than 60s"]);
  });
  it("fails a wrong status, a wrong content type and invalid JSON", () => {
    const c = compileRule(priceRule);
    expect(c.check(res(fresh, { status: 500 })).reasons).toEqual(["status 500 is outside 200-299"]);
    expect(c.check(res(fresh, { contentType: "text/html" })).reasons).toEqual(["content type is text/html, expected application/json"]);
    expect(c.check(res("{nope")).reasons).toEqual(["body is not valid JSON"]);
  });
  it("caches compiled rules by hash", () => {
    const reordered = JSON.parse(JSON.stringify({ status: priceRule.status, version: 1, contentType: "application/json", schema: priceRule.schema })) as RuleDefinition;
    expect(compileRule(reordered)).toBe(compileRule(priceRule));
  });
  it("rejects unknown versions", () => {
    expect(() => compileRule({ ...priceRule, version: 2 } as unknown as RuleDefinition)).toThrow(/version/);
  });
});

describe("inferRule", () => {
  const samples = [
    { symbol: "ADA", price: 0.42, updatedAt: "2026-10-06T11:59:50.000Z", createdAt: "2019-01-01T00:00:00Z", venue: "x" },
    { symbol: "ADA", price: 0.41, updatedAt: "2026-10-06T11:59:55.000Z", createdAt: "2019-01-01T00:00:00Z" },
  ];
  it("requires only fields present in every sample, with observed types", () => {
    const def = inferRule(samples);
    expect(def.status).toEqual({ min: 200, max: 299 });
    expect(def.contentType).toBe("application/json");
    expect(def.schema).toEqual({
      type: "object",
      required: ["createdAt", "price", "symbol", "updatedAt"],
      properties: {
        createdAt: { type: "string" },
        price: { type: "number" },
        symbol: { type: "string" },
        updatedAt: { type: "string", maxAgeSeconds: 900 },
      },
    });
  });
  it("inferred freshness tolerates a lagging price feed (6 min) but fails stale data (1 h) — contract v1.1 B2", () => {
    const c = compileRule(inferRule(samples));
    const at = (ageS: number) => new Date(NOW.getTime() - ageS * 1000).toISOString();
    const body = (ageS: number) => ({ symbol: "ADA", price: 0.4, updatedAt: at(ageS), createdAt: "2019-01-01T00:00:00Z" });
    expect(c.check(res(body(360))).pass).toBe(true);
    expect(c.check(res(body(3600))).pass).toBe(false);
  });
  it("the inferred rule fails the broken deploy ({})", () => {
    expect(compileRule(inferRule(samples)).check(res({})).pass).toBe(false);
  });
  it("leaves the rule unchanged when it already rejects the error sample", () => {
    expect(inferRule(samples, { error: "unknown symbol" })).toEqual(inferRule(samples));
  });
  it("tightens a loose rule with the error sample's distinctive keys", () => {
    const def = inferRule([{}, {}], { error: "x" });
    expect(compileRule(def).check(res({ error: "x" })).pass).toBe(false);
    expect(compileRule(def).check(res({})).pass).toBe(true);
  });
  it("refuses when the error response cannot be told apart", () => {
    expect(() => inferRule([{ a: 1 }], { a: 2 })).toThrow(/would accept the error response/);
  });
  it("types mixed values as a type list and needs at least one sample", () => {
    expect(inferRule([{ v: 1 }, { v: "1" }]).schema).toEqual({
      type: "object", required: ["v"], properties: { v: { type: ["number", "string"] } },
    });
    expect(() => inferRule([])).toThrow(/at least one/);
  });
});
