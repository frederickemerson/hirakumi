import { describe, expect, it } from "vitest";
import { formatTusdm, MoneyError, parsePackCalls, parseTusdm, perCallTusdm } from "./money";

describe("parseTusdm", () => {
  it.each([
    ["2", 2_000_000n],
    ["2.5", 2_500_000n],
    ["0.000001", 1n],
    [" 3 ", 3_000_000n],
    ["2.10", 2_100_000n],
  ])("parses %j to %s micros without floating point", (input, micros) => {
    expect(parseTusdm(input)).toBe(micros);
  });

  it.each(["", "abc", "-1", "1e6", "2,5", "2.0000001", ".5", "1234567890"])("rejects %j in plain English", (input) => {
    expect(() => parseTusdm(input)).toThrow(MoneyError);
    expect(() => parseTusdm(input)).toThrow(/Enter an amount like 2 or 2.50/);
  });
});

describe("formatTusdm", () => {
  it("formats micros as a short decimal", () => {
    expect(formatTusdm("2500000")).toBe("2.5");
    expect(formatTusdm(2_000_000n)).toBe("2");
    expect(formatTusdm("1")).toBe("0.000001");
  });
});

describe("parsePackCalls", () => {
  it("accepts whole numbers from 1 to 100000", () => {
    expect(parsePackCalls("100")).toBe(100);
    expect(parsePackCalls("1")).toBe(1);
  });
  it.each(["0", "1.5", "100001", "abc", ""])("rejects %j", (input) => {
    expect(() => parsePackCalls(input)).toThrow(MoneyError);
  });
});

describe("perCallTusdm", () => {
  it("divides the pack price across its calls", () => {
    expect(perCallTusdm("2000000", 100)).toBe("0.02");
  });
});
