import { describe, expect, it } from "vitest";
import { formatHealthReasons } from "../src/health";

describe("formatHealthReasons (health_events.reasons, contract v1.1 D5)", () => {
  it("formats {op, reason, since} objects as 'op: reason'", () => {
    expect(formatHealthReasons([{ op: "getPrice", reason: "/price is missing", since: "2026-10-07T10:00:10Z" }])).toEqual(["getPrice: /price is missing"]);
  });
  it("keeps plain strings, skips junk, and handles non-arrays", () => {
    expect(formatHealthReasons(["upstream answered 500", 42, null, { nope: 1 }])).toEqual(["upstream answered 500"]);
    expect(formatHealthReasons(null)).toEqual([]);
    expect(formatHealthReasons("x")).toEqual([]);
  });
  it("drops exact duplicates", () => {
    const r = { op: "getPrice", reason: "/usd is missing", since: "t" };
    expect(formatHealthReasons([r, r])).toEqual(["getPrice: /usd is missing"]);
  });
});
