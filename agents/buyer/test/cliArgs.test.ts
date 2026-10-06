import { describe, expect, it } from "vitest";
import { cliArgs } from "../src/cliArgs.js";

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
