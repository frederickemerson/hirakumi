import { describe, expect, it } from "vitest";
import {
  compileRule, inferRule, inferRuleFromResponses, isJsonMediaType, isTextMediaType, RuleInferenceError, ruleHash, type UpstreamResult,
} from "../src/index";

const res = (body: string, contentType: string | null, status = 200): UpstreamResult => ({ status, contentType, body, latencyMs: 1 });

describe("media types", () => {
  it("knows JSON and text types, and refuses binary", () => {
    for (const t of ["application/json", "application/vnd.api+json", "application/problem+json", "text/json", "text/x-json", "text/vnd.foo+json"]) {
      expect(isJsonMediaType(t), t).toBe(true);
      expect(isTextMediaType(t), t).toBe(false);
    }
    for (const t of ["text/plain", "text/csv", "text/html", "application/xml", "application/atom+xml", "application/csv", "application/yaml"]) {
      expect(isTextMediaType(t), t).toBe(true);
    }
    for (const t of ["image/png", "application/octet-stream", "application/pdf", "application/jsonx", ""]) {
      expect(isJsonMediaType(t) || isTextMediaType(t), t).toBe(false);
    }
  });
});

describe("inferRuleFromResponses", () => {
  it("gives the same rule (and hash) as before for application/json", () => {
    const good = [res('{"a":1}', "application/json; charset=utf-8"), res('{"a":2}', "application/json")];
    const def = inferRuleFromResponses(good, res('{"error":"x"}', "application/json", 404));
    expect(def).toEqual(inferRule([{ a: 1 }, { a: 2 }], { error: "x" }));
    expect(ruleHash(def)).toBe(ruleHash(inferRule([{ a: 1 }, { a: 2 }], { error: "x" })));
  });

  it("keeps a vendor JSON type and still checks the parsed body", () => {
    const def = inferRuleFromResponses([res('{"data":{"id":"1"}}', "application/vnd.api+json")]);
    expect(def.contentType).toBe("application/vnd.api+json");
    const rule = compileRule(def);
    expect(rule.check(res('{"data":{"id":"2"}}', "application/vnd.api+json")).pass).toBe(true);
    expect(rule.check(res('{"errors":[]}', "application/vnd.api+json")).reasons).toEqual(["/data is missing"]);
  });

  it("builds a text promise: media type, 2xx and a non-empty body", () => {
    const def = inferRuleFromResponses([res("ADA 0.35", "text/plain"), res("BTC 62000", "text/plain")], res("unknown symbol", "text/plain", 404));
    expect(def).toEqual({
      version: 1, status: { min: 200, max: 299 }, contentType: "text/plain",
      schema: { type: "string", minLength: 1, pattern: "\\S", not: { pattern: "^\\s*<(?:![Dd][Oo][Cc][Tt][Yy][Pp][Ee]\\s+[Hh][Tt][Mm][Ll]|[Hh][Tt][Mm][Ll])" } },
    });
    const rule = compileRule(def);
    expect(rule.check(res("ETH 3000", "text/plain; charset=utf-8")).pass).toBe(true);
    expect(rule.check(res("", "text/plain")).pass).toBe(false);
    expect(rule.check(res("x", "text/html")).reasons).toEqual(["content type is text/html, expected text/plain"]);
    expect(rule.check(res("x", "text/plain", 500)).pass).toBe(false);
  });

  it("requires a shared CSV header line, and it must survive regex characters", () => {
    const good = [res("sym,price(usd)\nADA,0.35\n", "text/csv"), res("sym,price(usd)\r\nBTC,62000", "text/csv")];
    const rule = compileRule(inferRuleFromResponses(good));
    expect(rule.check(res("sym,price(usd)\nETH,3000", "text/csv")).pass).toBe(true);
    expect(rule.check(res("error: rate limited\n", "text/csv")).pass).toBe(false);
    expect(rule.check(res("sym,price(usd)", "text/csv")).pass).toBe(false);
  });

  it("a blank body breaks a text promise", () => {
    const rule = compileRule(inferRuleFromResponses([res("ADA 0.35", "text/plain"), res("BTC 62000", "text/plain")]));
    for (const body of [" ", "\n\r\n\t  "]) expect(rule.check(res(body, "text/plain")).reasons, JSON.stringify(body)).toEqual(["/ is blank"]);
    expect(rule.check(res(" x ", "text/plain")).pass).toBe(true);
  });

  it("an HTML page sent as plain text or CSV breaks the promise; an HTML or XML promise still takes markup", () => {
    const plain = compileRule(inferRuleFromResponses([res("ADA 0.35", "text/plain")]));
    for (const page of ["<!DOCTYPE html><html><body>502 Bad Gateway</body></html>", "\n  <HTML><body>oops</body></HTML>", "<!doctype  HTML>"]) {
      expect(plain.check(res(page, "text/plain")).reasons, page).toEqual(["/ looks like an error response"]);
    }
    expect(plain.check(res("price <html> tag count: 3", "text/plain")).pass).toBe(true);
    const csv = compileRule(inferRuleFromResponses([res("sym,price\nADA,0.35\n", "text/csv"), res("sym,price\nBTC,1\n", "text/csv")]));
    expect(csv.check(res("<html><body>sym,price\n</body></html>", "text/csv")).pass).toBe(false);
    const html = compileRule(inferRuleFromResponses([res("<!doctype html><p>hi</p>", "text/html")]));
    expect(html.check(res("<!DOCTYPE html><p>ok</p>", "text/html")).pass).toBe(true);
    const xml = compileRule(inferRuleFromResponses([res("<feed/>", "application/atom+xml")]));
    expect(xml.check(res("<html/>", "application/atom+xml")).pass).toBe(true);
    // A text error sent with 2xx and no markup ("Rate limit exceeded") still passes: the status code is the signal.
    expect(plain.check(res("Rate limit exceeded", "text/plain", 429)).pass).toBe(false);
  });

  it("one body repeated (QA calls the same example 5 times) does not pin its first data line as a header", () => {
    const same = Array.from({ length: 5 }, () => res("ADA 0.35\nupdated now\n", "text/plain"));
    const def = inferRuleFromResponses(same);
    expect(def.schema.pattern).toBe("\\S");
    expect(compileRule(def).check(res("ADA 0.36\nupdated now\n", "text/plain")).pass).toBe(true);
    // Two different bodies that share the first line do.
    const two = inferRuleFromResponses([...same, res("ADA 0.35\nupdated later\n", "text/plain")]);
    expect(two.schema.pattern).toBe("^ADA 0\\.35\\r?\\n");
  });

  it("JSON sent as text/json is parsed and checked as JSON", () => {
    const def = inferRuleFromResponses([res('{"a":1}', "text/json"), res('{"a":2}', "text/json; charset=utf-8")]);
    expect(def).toEqual({ ...inferRule([{ a: 1 }, { a: 2 }]), contentType: "text/json" });
    const rule = compileRule(def);
    expect(rule.check(res('{"a":3}', "text/json")).pass).toBe(true);
    expect(rule.check(res('{"b":3}', "text/json")).reasons).toEqual(["/a is missing"]);
    expect(rule.check(res("a=1", "text/json")).reasons).toEqual(["body is not valid JSON"]);
    expect(compileRule({ ...def, contentType: "text/x-json" }).check(res("nope", "text/x-json")).reasons).toEqual(["body is not valid JSON"]);
  });

  it("refuses when a wrong request gets a passing text answer", () => {
    expect(() => inferRuleFromResponses([res("ADA 0.35", "text/plain")], res("no such symbol", "text/plain", 200))).toThrow(RuleInferenceError);
  });

  it("refuses binary answers and mixed media types with a plain reason", () => {
    expect(() => inferRuleFromResponses([res("\u0089PNG", "image/png")])).toThrow(/image\/png, which Hirakumi can't check yet/);
    expect(() => inferRuleFromResponses([res("{}", "application/json"), res("x", "text/plain")])).toThrow(/different content types/);
  });
});
