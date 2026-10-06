import { inferRuleFromResponses, withRequiredPhrase, type RuleDefinition } from "@hirakumi/core";
import { describe, expect, it, vi } from "vitest";
import type { StructuredCall } from "../src/llm/claude.js";
import { LlmRefusalError } from "../src/llm/claude.js";
import { fallbackRuleText, headerLineOf, writeRuleText } from "../src/llm/ruleText.js";

const RULE: RuleDefinition = {
  version: 1,
  status: { min: 200, max: 299 },
  contentType: "application/json",
  schema: { type: "object", required: ["price", "at"], properties: { price: { type: "number" }, at: { type: "string", maxAgeSeconds: 60 } } },
};
const INPUT = { apiName: "Price API", ops: [{ opId: "getPrice", description: "Latest price.", rule: RULE }] };

describe("fallbackRuleText", () => {
  it("states status, required fields and freshness in plain English", () => {
    expect(fallbackRuleText(RULE)).toBe(
      'A response counts as good when the status is 200-299 and the body is JSON, it contains "price" (a number), "at" (text), "at" is no older than 60 seconds.',
    );
  });
});

describe("fallbackRuleText for answers that are not JSON", () => {
  const answer = (contentType: string, body: string) => ({ status: 200, contentType, body, latencyMs: 1 });

  it("says the type, that it is not empty, and the header line every answer starts with", () => {
    const rule = inferRuleFromResponses([answer("text/csv; charset=utf-8", "date,price (usd)\n2024-01-01,1.5\n"), answer("text/csv", "date,price (usd)\n2024-01-02,1.6\n")]);
    expect(fallbackRuleText(rule)).toBe('A response counts as good when the status is 200-299 and the body is text/csv text, not empty, starting with the line "date,price (usd)", and not an HTML page or an error message.');
  });

  it("leaves the header out when the answers share none", () => {
    const rule = inferRuleFromResponses([answer("text/plain", "1.5"), answer("text/plain", "1.6")]);
    expect(fallbackRuleText(rule)).toBe(
      "A response counts as good when the status is 200-299 and the body is text/plain text, not empty, and not an HTML page or an error message. This is a status-only promise: it does not check the content.",
    );
    expect(fallbackRuleText(rule)).not.toMatch(/JSON|format/);
  });

  it("an HTML or XML answer may be markup, so it only refuses error text", () => {
    for (const ct of ["text/html", "application/xml"]) {
      const rule = inferRuleFromResponses([answer(ct, "<p>1.5</p>"), answer(ct, "<p>1.6</p>")]);
      expect(fallbackRuleText(rule)).toBe(
        `A response counts as good when the status is 200-299 and the body is ${ct} text, not empty, and not an error message. This is a status-only promise: it does not check the content.`,
      );
    }
  });

  it("lists each required phrase, after the header line", () => {
    const csv = inferRuleFromResponses([answer("text/csv", "date,price\n2024-01-01,1.5\n"), answer("text/csv", "date,price\n2024-01-02,1.6\n")]);
    const both = withRequiredPhrase(withRequiredPhrase(csv, "BTC"), 'say "hi"');
    expect(fallbackRuleText(both)).toBe(
      'A response counts as good when the status is 200-299 and the body is text/csv text, not empty, starting with the line "date,price", containing "BTC", containing "say \\"hi\\"", and not an HTML page or an error message.',
    );
    const plain = inferRuleFromResponses([answer("text/plain", "1.5"), answer("text/plain", "1.6")]);
    expect(fallbackRuleText(withRequiredPhrase(plain, "price: 1.5 (usd)"))).toBe(
      'A response counts as good when the status is 200-299 and the body is text/plain text, not empty, containing "price: 1.5 (usd)", and not an HTML page or an error message.',
    );
  });

  it("still renders rules made before error text was refused", () => {
    const legacyHtml = "^\\s*<(?:![Dd][Oo][Cc][Tt][Yy][Pp][Ee]\\s+[Hh][Tt][Mm][Ll]|[Hh][Tt][Mm][Ll])";
    const base: RuleDefinition = { ...RULE, contentType: "text/csv", schema: { type: "string", minLength: 1, pattern: "^a,b\\r?\\n", not: { pattern: legacyHtml } } };
    expect(fallbackRuleText(base)).toBe('A response counts as good when the status is 200-299 and the body is text/csv text, not empty, starting with the line "a,b", and not an HTML page.');
    expect(fallbackRuleText({ ...base, schema: { type: "string", minLength: 1, pattern: "\\S", not: { pattern: legacyHtml } } })).toBe(
      "A response counts as good when the status is 200-299 and the body is text/csv text, not empty, and not an HTML page. This is a status-only promise: it does not check the content.",
    );
  });

  it("still names a pattern it can't read back as a format, and reads a non-blank pattern as not empty", () => {
    const base: RuleDefinition = { ...RULE, contentType: "text/plain", schema: { type: "string", pattern: "^\\d+$" } };
    expect(fallbackRuleText(base)).toBe("A response counts as good when the status is 200-299 and the body is text/plain text, matching the format of its test answers.");
    expect(fallbackRuleText({ ...base, schema: { type: "string", pattern: "\\S" } })).toBe(
      "A response counts as good when the status is 200-299 and the body is text/plain text, not empty. This is a status-only promise: it does not check the content.",
    );
  });

  it("names a vendor JSON type, and keeps plain JSON wording unchanged", () => {
    expect(fallbackRuleText({ ...RULE, contentType: "application/vnd.api+json" })).toMatch(/^A response counts as good when the status is 200-299 and the body is JSON \(application\/vnd\.api\+json\), it contains/);
  });

  it("reads back only patterns core wrote", () => {
    expect(headerLineOf("^a\\.b \\(x\\)\\r?\\n")).toBe("a.b (x)");
    expect(headerLineOf("^a.*\\r?\\n")).toBeNull();
    expect(headerLineOf(undefined)).toBeNull();
  });
});

describe("writeRuleText", () => {
  it("uses the model only for the listing; the buyer-facing promise always comes from the rule (audit I3)", async () => {
    const llm = vi.fn().mockResolvedValue({
      // A seller-steered model claiming more than the rule enforces:
      rules: [{ opId: "getPrice", promise: "A response counts as good when the price is guaranteed accurate and no older than 5 seconds." }],
      listing: { summary: "Live crypto prices", description: "Current prices for major tickers.", tags: ["Crypto", "prices", "crypto"] },
    }) as unknown as StructuredCall;
    const r = await writeRuleText(llm, INPUT);
    expect(r.usedFallback).toBe(false);
    expect(r.texts.get("getPrice")).toBe(fallbackRuleText(RULE));
    expect(r.listing).toEqual({ summary: "Live crypto prices", description: "Current prices for major tickers.", tags: ["crypto", "prices"] });
  });

  it("falls back to a deterministic listing on refusal", async () => {
    const refusing = vi.fn().mockRejectedValue(new LlmRefusalError("no")) as unknown as StructuredCall;
    const r1 = await writeRuleText(refusing, INPUT);
    expect(r1.usedFallback).toBe(true);
    expect(r1.texts.get("getPrice")).toBe(fallbackRuleText(RULE));
    const badListing = vi.fn().mockResolvedValue({ listing: { summary: "", description: "d", tags: ["a"] } }) as unknown as StructuredCall;
    expect((await writeRuleText(badListing, INPUT)).usedFallback).toBe(true);
  });
});
