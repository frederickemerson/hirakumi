import type { RuleDefinition } from "@hirakumi/core";
import { describe, expect, it, vi } from "vitest";
import type { StructuredCall } from "../src/llm/claude.js";
import { LlmRefusalError } from "../src/llm/claude.js";
import { fallbackRuleText, writeRuleText } from "../src/llm/ruleText.js";

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

describe("writeRuleText", () => {
  it("uses the model's promise and listing when they pass validation", async () => {
    const llm = vi.fn().mockResolvedValue({
      rules: [{ opId: "getPrice", promise: "A response counts as good when it has a numeric price no older than a minute." }],
      listing: { summary: "Live crypto prices", description: "Current prices for major tickers.", tags: ["Crypto", "prices", "crypto"] },
    }) as unknown as StructuredCall;
    const r = await writeRuleText(llm, INPUT);
    expect(r.usedFallback).toBe(false);
    expect(r.texts.get("getPrice")).toMatch(/^A response counts as good/);
    expect(r.listing.tags).toEqual(["crypto", "prices"]);
  });

  it("falls back to deterministic text on refusal or a missing promise", async () => {
    const refusing = vi.fn().mockRejectedValue(new LlmRefusalError("no")) as unknown as StructuredCall;
    const r1 = await writeRuleText(refusing, INPUT);
    expect(r1.usedFallback).toBe(true);
    expect(r1.texts.get("getPrice")).toBe(fallbackRuleText(RULE));
    const partial = vi.fn().mockResolvedValue({ rules: [], listing: { summary: "s", description: "d", tags: ["a"] } }) as unknown as StructuredCall;
    expect((await writeRuleText(partial, INPUT)).usedFallback).toBe(true);
  });
});
