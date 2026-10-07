import { describe, expect, it } from "vitest";
import {
  compileRule, inferRuleFromResponses, inferTextRule, isStatusOnlyRule, requiredPhrasesOf, RuleInferenceError, ruleHash, suggestPhrase,
  withRequiredPhrase, type RuleDefinition, type UpstreamResult,
} from "../src/index";
import * as mediaTypes from "../src/mediaTypes";

const res = (body: string, contentType: string | null, status = 200): UpstreamResult => ({ status, contentType, body, latencyMs: 1 });
const NOT_FOUND = (ct: string) => res("unknown input", ct, 404);

/**
 * A text promise does not guess from words whether an answer is an error: the status and the media type are the
 * signal, and before publishing the seller confirms a phrase every good answer contains (the publish gate).
 */
describe("text APIs whose data looks like an error message", () => {
  const cases: [name: string, ct: string, good: string[], phrase: string][] = [
    ["a CSV with an error column", "text/csv", ["error,count\ntimeout,3\n", "error,count\ndns,1\n"], "error,count"],
    ["an XML document with an <errors> root", "application/xml",
      ['<errors><item code="E1">disk full</item></errors>', '<errors><item code="E2">cpu hot</item></errors>'], "<errors>"],
    ["a log API", "text/plain", [
      "2026-10-07T12:00:01Z ERROR db timeout\nTraceback (most recent call last):\n  File \"/app/x.py\", line 1\n",
      "2026-10-07T12:00:02Z FATAL out of memory\n    at main (/app/index.js:3:9)\n",
    ], "Z "],
    ["a news line", "text/plain", ["Fatal accidents fell 3%", "Fatal accidents rose 1%"], "Fatal accidents"],
    ["an HTTP status report", "text/plain", ["Internal Server Error: 0 in the last hour", "Internal Server Error: 2 in the last hour"], "in the last hour"],
  ];

  it.each(cases)("%s gets a promise its own answers keep, and publishes once the seller confirms a phrase", (_name, ct, good, phrase) => {
    const def = inferRuleFromResponses(good.map((b) => res(b, ct)), NOT_FOUND(ct));
    const rule = compileRule(def);
    for (const b of good) expect(rule.check(res(b, ct)), b).toEqual({ pass: true, reasons: [] });
    expect(isStatusOnlyRule(def)).toBe(true);
    const confirmed = withRequiredPhrase(def, phrase);
    expect(isStatusOnlyRule(confirmed)).toBe(false);
    for (const b of good) expect(compileRule(confirmed).check(res(b, ct)).pass, b).toBe(true);
  });

  it("an error answer with a 4xx or 5xx status breaks the promise", () => {
    const rule = compileRule(inferTextRule("text/plain", ["ADA 0.35"]));
    expect(rule.check(res("Rate limit exceeded", "text/plain", 429)).pass).toBe(false);
    expect(rule.check(res("Internal Server Error", "text/plain", 500)).pass).toBe(false);
  });

  it("refuses to build a promise a 2xx answer to a wrong input would keep", () => {
    expect(() => inferTextRule("text/plain", ["ADA 0.35"], res("no such symbol", "text/plain", 404))).not.toThrow();
    expect(() => inferTextRule("text/plain", ["ADA 0.35"], res("no such symbol", "text/plain"))).toThrow(RuleInferenceError);
  });
});

describe("first lines", () => {
  const twoBodies = (first: string) => [`${first}\nADA,0.35\n`, `${first}\nBTC,62000\n`];

  it.each(["# build abc123", "Report 2026-10-07 12:00", "symbol,price_usd_24h"])(
    "%j is not pinned on its own: the seller confirms what every answer contains", (first) => {
      const def = inferTextRule("text/csv", twoBodies(first));
      expect(def.schema.pattern).toBe("\\S");
      expect(isStatusOnlyRule(def)).toBe(true);
    },
  );

  it("an answer whose first line changed later still keeps the promise", () => {
    const build = compileRule(inferTextRule("text/plain", twoBodies("# build abc123")));
    expect(build.check(res("# build def456\nADA,0.36\n", "text/plain")).pass).toBe(true);
    const report = compileRule(inferTextRule("text/plain", twoBodies("Report 2026-10-07 12:00")));
    expect(report.check(res("Report 2026-10-08 09:30\nADA,0.36\n", "text/plain")).pass).toBe(true);
  });

  it("a header pinned by an earlier release still counts as more than status-only", () => {
    const stored: RuleDefinition = { ...inferTextRule("text/csv", ["x"]), schema: { ...inferTextRule("text/csv", ["x"]).schema, pattern: "^symbol,price\\r?\\n" } };
    expect(isStatusOnlyRule(stored)).toBe(false);
    expect(compileRule(stored).check(res("symbol,price\nADA,1\n", "text/csv")).pass).toBe(true);
    expect(compileRule(stored).check(res("other\nADA,1\n", "text/csv")).pass).toBe(false);
  });
});

describe("isStatusOnlyRule and withRequiredPhrase", () => {
  const status = inferTextRule("text/plain", ["ADA 0.35"]);
  const header: RuleDefinition = { ...inferTextRule("text/csv", ["x"]), schema: { ...inferTextRule("text/csv", ["x"]).schema, pattern: "^symbol,price\\r?\\n" } };

  it("knows a status-only text rule", () => {
    expect(isStatusOnlyRule(status)).toBe(true);
    expect(isStatusOnlyRule(inferTextRule("text/html", ["<p>x</p>"]))).toBe(true);
    expect(isStatusOnlyRule({ ...status, schema: { type: "string", minLength: 1, pattern: "\\S" } })).toBe(true);
    expect(isStatusOnlyRule(header)).toBe(false);
    expect(isStatusOnlyRule(withRequiredPhrase(status, "ADA"))).toBe(false);
    expect(isStatusOnlyRule(inferRuleFromResponses([res('{"a":1}', "application/json")]))).toBe(false);
    expect(isStatusOnlyRule({ ...status, schema: { ...status.schema, not: { pattern: "x" } } })).toBe(false);
  });

  it("requires the phrase as typed in any case, regex characters included", () => {
    const def = withRequiredPhrase(status, "  price (usd): ");
    expect(def.schema).toEqual({
      type: "string", minLength: 1, not: status.schema.not,
      allOf: [{ pattern: "\\S" }, { pattern: "[pP][rR][iI][cC][eE] \\([uU][sS][dD]\\):" }],
    });
    expect(status.schema.pattern).toBe("\\S");
    expect(requiredPhrasesOf(def)).toEqual(["price (usd):"]);
    const rule = compileRule(def);
    expect(rule.check(res("ADA price (usd): 0.35", "text/plain")).pass).toBe(true);
    expect(rule.check(res("ADA Price (USD): 0.35", "text/plain")).pass).toBe(true);
    expect(rule.check(res("ADA price usd: 0.35", "text/plain")).reasons).toEqual(['/ does not contain "price (usd):"']);
    expect(rule.check(res("Not Found", "text/plain")).pass).toBe(false);
    expect(rule.check(res(" ", "text/plain")).reasons).toContain("/ is blank");
  });

  it("keeps a pinned header and adds phrases once", () => {
    const def = withRequiredPhrase(withRequiredPhrase(withRequiredPhrase(header, "ADA"), "ADA"), "BTC");
    expect(def.schema.allOf).toEqual([{ pattern: "^symbol,price\\r?\\n" }, { pattern: "[Aa][Dd][Aa]" }, { pattern: "[Bb][Tt][Cc]" }]);
    expect(requiredPhrasesOf(def)).toEqual(["ADA", "BTC"]);
    expect(compileRule(def).check(res("symbol,price\nADA,1\nBTC,2\n", "text/csv")).pass).toBe(true);
    expect(compileRule(def).check(res("symbol,price\nADA,1\n", "text/csv")).pass).toBe(false);
  });

  it("reads a phrase back in the case the seller typed it, accents and brackets included", () => {
    const def = withRequiredPhrase(status, "Prix en Été [EUR] ß 1.5");
    expect(requiredPhrasesOf(def)).toEqual(["Prix en Été [EUR] ß 1.5"]);
    const rule = compileRule(def);
    expect(rule.check(res("x PRIX EN été [eur] ß 1.5 y", "text/plain")).pass).toBe(true);
    expect(rule.check(res("x prix en ete [eur] ß 1.5 y", "text/plain")).reasons).toEqual(['/ does not contain "Prix en Été [EUR] ß 1.5"']);
  });

  it("keeps the exact case of a phrase stored before, with the same hash", () => {
    // As the previous release wrote it: the escaped phrase, matched in its exact case.
    const stored = { ...status, schema: { type: "string", minLength: 1, not: status.schema.not, allOf: [{ pattern: "\\S" }, { pattern: "Price \\[usd\\]" }] } };
    const hash = ruleHash(stored);
    expect(requiredPhrasesOf(stored)).toEqual(["Price [usd]"]);
    const rule = compileRule(stored);
    expect(rule.hash).toBe(hash);
    expect(rule.check(res("ADA Price [usd] 0.35", "text/plain")).pass).toBe(true);
    expect(rule.check(res("ADA price [usd] 0.35", "text/plain")).reasons).toEqual(['/ does not contain "Price [usd]"']);
    expect(isStatusOnlyRule(stored)).toBe(false);
  });

  it("refuses JSON rules and bad phrases", () => {
    expect(() => withRequiredPhrase(inferRuleFromResponses([res('{"a":1}', "application/json")]), "a")).toThrow(RuleInferenceError);
    for (const p of ["", "   ", "x".repeat(201), "a\nb"]) expect(() => withRequiredPhrase(status, p), JSON.stringify(p)).toThrow(RuleInferenceError);
    expect(withRequiredPhrase(status, "x".repeat(200)).schema.allOf).toHaveLength(2);
  });
});

describe("suggestPhrase", () => {
  it("finds the longest phrase every good answer has and the bad answer lacks", () => {
    expect(suggestPhrase(["ADA price in USD: 0.35", "BTC price in USD: 62000"], "unknown symbol")).toBe("price in USD:");
    expect(suggestPhrase(["Daily price report\nADA 0.35\n", "Daily price report\nBTC 62000\n"])).toBe("Daily price report");
  });

  it("skips digits, line ends, tags and phrases the bad answer has", () => {
    expect(suggestPhrase(["symbol ADA last 0.35 venue binance", "symbol BTC last 62000 venue kraken"], "symbol XYZ last unknown venue none")).toBe(null);
    expect(suggestPhrase(["<h1>Cardano price</h1><p>0.35</p>", "<h1>Cardano price</h1><p>0.36</p>"])).toBe("Cardano price");
    expect(suggestPhrase(["Price of ADA", "Price of BTC"], "PRICE OF nothing")).toBe(null);
  });

  it("judges a phrase by the answers, not by its words", () => {
    expect(suggestPhrase(["Internal server status: green", "Internal server status: red"])).toBe("Internal server status:");
    expect(suggestPhrase(["error,count\ntimeout,3\n", "error,count\ndns,1\n"], "unknown input")).toBe("error,count");
    expect(suggestPhrase(["Fatal accidents fell 3%", "Fatal accidents rose 1%"], "unknown input")).toBe("Fatal accidents");
  });

  it("keeps the phrase between 3 and 60 characters and prefers the earliest of equal ones", () => {
    const long = "the quick brown fox jumps over the lazy dog and keeps running far away";
    expect(suggestPhrase([`${long} 1`, `${long} 2`])!.length).toBeLessThanOrEqual(60);
    expect(suggestPhrase(["ab 1", "ab 2"])).toBe(null);
    expect(suggestPhrase(["alpha 1 gamma", "gamma 2 alpha"])).toBe("alpha");
    expect(suggestPhrase([])).toBe(null);
  });

  it("suggests nothing from one answer repeated: its words may belong to that one input", () => {
    const one = "Cardano (ADA) price today: 0.35 USD";
    expect(suggestPhrase([one, one, one, one, one], "unknown symbol")).toBe(null);
    expect(suggestPhrase([one, one, one, one, one, "Bitcoin (BTC) price today: 62000 USD"], "unknown symbol")).toBe("price today:");
  });

  it("gives a phrase that withRequiredPhrase takes and the good answers keep", () => {
    const good = ["Cardano (ADA) price: 0.35 USD", "Bitcoin (BTC) price: 62000 USD"];
    const phrase = suggestPhrase(good, "Error: unknown symbol")!;
    expect(phrase).toBe("price:");
    const rule = compileRule(withRequiredPhrase(inferTextRule("text/plain", good), phrase));
    for (const b of good) expect(rule.check(res(b, "text/plain")).pass).toBe(true);
  });

  it("is quick on a large CSV", () => {
    const rows = (n: number) => `symbol,price,venue name\n${Array.from({ length: 3000 }, (_, i) => `S${i},${i + n},Main venue`).join("\n")}`;
    const t0 = performance.now();
    expect(suggestPhrase([rows(1), rows(2), rows(3)])).toBe("symbol,price,venue name");
    expect(performance.now() - t0).toBeLessThan(2_000);
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

describe("inferRuleFromResponses with a JSON media type", () => {
  it("says the answer isn't JSON with a RuleInferenceError, not a SyntaxError", () => {
    expect(() => inferRuleFromResponses([res("not json", "application/json")])).toThrow(RuleInferenceError);
  });
});
