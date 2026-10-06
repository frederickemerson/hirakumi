import { describe, expect, it } from "vitest";
import { cliArgs, queryArgs } from "../src/cliArgs.js";

describe("cliArgs", () => {
  it("drops the leading -- that pnpm forwards to the script", () => {
    expect(cliArgs(["node", "escrow.ts", "--", "--api", "a1"])).toEqual(["--api", "a1"]);
  });
  it("keeps arguments when there is no leading --", () => {
    expect(cliArgs(["node", "escrow.ts", "--api", "a1"])).toEqual(["--api", "a1"]);
  });
  it("only drops the first --", () => {
    expect(cliArgs(["node", "x", "--", "--api", "--"])).toEqual(["--api", "--"]);
  });
});

describe("queryArgs", () => {
  it("falls back to { symbol } without --query", () => {
    expect(queryArgs(undefined, "ADA")).toEqual({ symbol: "ADA" });
    expect(queryArgs([], "BTC")).toEqual({ symbol: "BTC" });
  });
  it("uses the --query pairs instead of symbol", () => {
    expect(queryArgs(["city=tokyo", "units=metric"], "ADA")).toEqual({ city: "tokyo", units: "metric" });
  });
  it("splits on the first = only", () => {
    expect(queryArgs(["q=a=b"], "ADA")).toEqual({ q: "a=b" });
  });
  it("rejects a pair without a name or =", () => {
    expect(() => queryArgs(["tokyo"], "ADA")).toThrow(/name=value/);
    expect(() => queryArgs(["=tokyo"], "ADA")).toThrow(/name=value/);
  });
});
