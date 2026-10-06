import { describe, expect, it } from "vitest";
import {
  compileRule, inferRuleFromResponses, inferTextRule, isStatusOnlyRule, requiredPhrasesOf, RuleInferenceError, withRequiredPhrase,
  type RuleDefinition, type UpstreamResult,
} from "../src/index";
import * as mediaTypes from "../src/mediaTypes";

const res = (body: string, contentType: string | null, status = 200): UpstreamResult => ({ status, contentType, body, latencyMs: 1 });
const plain = compileRule(inferTextRule("text/plain", ["ADA 0.35"]));

describe("text promises refuse error bodies sent with 2xx", () => {
  it.each([
    "Error", "error: rate limited", "  Internal Server Error\n", "internal error", "Rate limit exceeded", "rate limited", "RATE LIMIT",
    "Too Many Requests", "Service Unavailable", "Bad Gateway", "Gateway Timeout", "Not Found", "not found", "Forbidden",
    "Unauthorized", "Maintenance", "maintenance until 12:00", "Timeout", "404 Not Found", "503 - Service Unavailable",
    "HTTP/1.1 502 Bad Gateway", "<h1>Not Found</h1>", "<title>500</title>", "\n <body>oops</body>", "<HEAD><title>x</title></HEAD>",
  ])("refuses %j", (body) => {
    expect(plain.check(res(body, "text/plain")).reasons).toEqual(["/ looks like an error response"]);
  });

  it.each([
    "ADA 0.35", "symbol,price\nADA,0.35\n", "Errors: 0", "error_count=0", "notfound_total 3", "price <html> tag count: 3", "<header>x</header>",
    "timeouts,errors\n0,0\n",
  ])("passes %j", (body) => {
    expect(plain.check(res(body, "text/plain")).pass).toBe(true);
  });

  it("refuses only short error texts: a long answer starting with an error word is data", () => {
    expect(plain.check(res(`Error rates by region\n${"eu,0.1\n".repeat(40)}`, "text/plain")).pass).toBe(true);
    expect(plain.check(res(`Error ${"x".repeat(193)}`, "text/plain")).pass).toBe(false);
    expect(plain.check(res(`Error ${"x".repeat(194)}`, "text/plain")).pass).toBe(true);
  });

  it("HTML and XML promises take markup but refuse a short error text", () => {
    const html = compileRule(inferTextRule("text/html", ["<!doctype html><p>hi</p>"]));
    expect(html.check(res("<!DOCTYPE html><title>Prices</title><p>ADA 0.35</p>", "text/html")).pass).toBe(true);
    expect(html.check(res("<h1>Prices</h1><p>ADA 0.35</p>", "text/html")).pass).toBe(true);
    expect(html.check(res("<html><body><h1>502 Bad Gateway</h1></body></html>", "text/html")).pass).toBe(false);
    const xml = compileRule(inferTextRule("application/xml", ["<feed/>"]));
    expect(xml.check(res('<?xml version="1.0"?><prices><ADA>0.35</ADA></prices>', "application/xml")).pass).toBe(true);
    expect(xml.check(res("<head/>", "application/xml")).pass).toBe(true);
    expect(xml.check(res("<error>Rate limit exceeded</error>", "application/xml")).pass).toBe(false);
  });

  it("a CSV answer with a pinned header still passes, and an error body breaks it", () => {
    const csv = compileRule(inferRuleFromResponses([res("symbol,price_usd_24h\nADA,0.35\n", "text/csv"), res("symbol,price_usd_24h\nBTC,1\n", "text/csv")]));
    expect(csv.check(res("symbol,price_usd_24h\nETH,3000\n", "text/csv")).pass).toBe(true);
    expect(csv.check(res("Not Found", "text/csv")).pass).toBe(false);
  });

  it("refuses to build a promise that a 200 error body would keep", () => {
    expect(() => inferTextRule("text/plain", ["ADA 0.35"], res("Not Found", "text/plain"))).not.toThrow();
    expect(() => inferTextRule("text/plain", ["ADA 0.35"], res("no such symbol", "text/plain"))).toThrow(RuleInferenceError);
  });
});

describe("pinned header line", () => {
  const pinned = (first: string) =>
    inferTextRule("text/csv", [`${first}\nADA,0.35\n`, `${first}\nBTC,62000\n`]).schema.pattern !== "\\S";

  it("pins a header shared by two different bodies", () => {
    expect(pinned("symbol,price_usd_24h")).toBe(true);
    expect(pinned('"symbol";"price (usd)"')).toBe(true);
  });

  it.each([
    "Report 2026-10-07 12:00", "as of 07/10/2026", "updated 12:00:00", "2026-10-07T12:00:00Z", "ts 1759838400", "total 42",
    "change -3.5%", "ADA 0.35", "x".repeat(301),
  ])("does not pin %j", (first) => expect(pinned(first)).toBe(false));

  it("one body repeated is not enough", () => {
    expect(inferTextRule("text/csv", ["symbol,price\nADA,1\n", "symbol,price\nADA,1\n"]).schema.pattern).toBe("\\S");
  });
});

describe("isStatusOnlyRule and withRequiredPhrase", () => {
  const status = inferTextRule("text/plain", ["ADA 0.35"]);
  const header = inferTextRule("text/csv", ["symbol,price\nADA,1\n", "symbol,price\nBTC,2\n"]);
  const legacy: RuleDefinition = {
    version: 1, status: { min: 200, max: 299 }, contentType: "text/plain",
    schema: { type: "string", minLength: 1, pattern: "\\S", not: { pattern: "^\\s*<(?:![Dd][Oo][Cc][Tt][Yy][Pp][Ee]\\s+[Hh][Tt][Mm][Ll]|[Hh][Tt][Mm][Ll])" } },
  };

  it("knows a status-only text rule", () => {
    expect(isStatusOnlyRule(status)).toBe(true);
    expect(isStatusOnlyRule(inferTextRule("text/html", ["<p>x</p>"]))).toBe(true);
    expect(isStatusOnlyRule(legacy)).toBe(true);
    expect(isStatusOnlyRule(header)).toBe(false);
    expect(isStatusOnlyRule(withRequiredPhrase(status, "ADA"))).toBe(false);
    expect(isStatusOnlyRule(inferRuleFromResponses([res('{"a":1}', "application/json")]))).toBe(false);
    expect(isStatusOnlyRule({ ...status, schema: { ...status.schema, not: { pattern: "x" } } })).toBe(false);
  });

  it("requires the phrase as typed, regex characters included", () => {
    const def = withRequiredPhrase(status, "  price (usd): ");
    expect(def.schema).toEqual({ type: "string", minLength: 1, not: status.schema.not, allOf: [{ pattern: "\\S" }, { pattern: "price \\(usd\\):" }] });
    expect(status.schema.pattern).toBe("\\S");
    expect(requiredPhrasesOf(def)).toEqual(["price (usd):"]);
    const rule = compileRule(def);
    expect(rule.check(res("ADA price (usd): 0.35", "text/plain")).pass).toBe(true);
    expect(rule.check(res("ADA price usd: 0.35", "text/plain")).reasons).toEqual(['/ does not contain "price (usd):"']);
    expect(rule.check(res("Not Found", "text/plain")).pass).toBe(false);
    expect(rule.check(res(" ", "text/plain")).reasons).toContain("/ is blank");
  });

  it("keeps a pinned header and adds phrases once", () => {
    const def = withRequiredPhrase(withRequiredPhrase(withRequiredPhrase(header, "ADA"), "ADA"), "BTC");
    expect(def.schema.allOf).toEqual([{ pattern: "^symbol,price\\r?\\n" }, { pattern: "ADA" }, { pattern: "BTC" }]);
    expect(requiredPhrasesOf(def)).toEqual(["ADA", "BTC"]);
    expect(compileRule(def).check(res("symbol,price\nADA,1\nBTC,2\n", "text/csv")).pass).toBe(true);
    expect(compileRule(def).check(res("symbol,price\nADA,1\n", "text/csv")).pass).toBe(false);
  });

  it("refuses JSON rules and bad phrases", () => {
    expect(() => withRequiredPhrase(inferRuleFromResponses([res('{"a":1}', "application/json")]), "a")).toThrow(RuleInferenceError);
    for (const p of ["", "   ", "x".repeat(201), "a\nb"]) expect(() => withRequiredPhrase(status, p), JSON.stringify(p)).toThrow(RuleInferenceError);
    expect(withRequiredPhrase(status, "x".repeat(200)).schema.allOf).toHaveLength(2);
  });
});

describe("media types module", () => {
  it("is the one the rules use, with no Node imports", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/mediaTypes.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/^import /m);
    expect(mediaTypes.mediaTypeOf("Text/CSV; charset=utf-8")).toBe("text/csv");
    expect(mediaTypes.isTextMediaType("text/csv")).toBe(true);
    expect(mediaTypes.isJsonMediaType("application/problem+json")).toBe(true);
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { exports: Record<string, string> };
    expect(pkg.exports["./media-types"]).toBe("./src/mediaTypes.ts");
  });
});
