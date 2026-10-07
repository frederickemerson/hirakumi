import { describe, expect, it } from "vitest";
import { isOperatorOnly, KEY_REFUSED_TEXT, OPERATOR_KEYS_UNAVAILABLE } from "../src/reasons";

describe("isOperatorOnly", () => {
  it("is true only when every reason is the operator's", () => {
    const op = { op: "*", reason: OPERATOR_KEYS_UNAVAILABLE, since: "2026-10-07T00:00:00Z" };
    expect(isOperatorOnly([op])).toBe(true);
    expect(isOperatorOnly([op, OPERATOR_KEYS_UNAVAILABLE])).toBe(true);
    expect(isOperatorOnly([op, { op: "getPrice", reason: KEY_REFUSED_TEXT }])).toBe(false);
    expect(isOperatorOnly([])).toBe(false);
    expect(isOperatorOnly(null)).toBe(false);
    expect(isOperatorOnly([op, 42])).toBe(false);
  });
});
