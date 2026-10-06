import { describe, expect, it } from "vitest";
import { isLiveBuyApi, tryLiveApis } from "./try-live";

describe("TRY_LIVE_APIS on the web (audit I2)", () => {
  it("defaults to the featured demo API, like the gateway", () => {
    expect(tryLiveApis(undefined)).toEqual(["api_eejiaioyqt"]);
    expect(isLiveBuyApi("api_eejiaioyqt", undefined)).toBe(true);
    expect(isLiveBuyApi("api_attacker", undefined)).toBe(false);
  });
  it("reads a comma list, and an empty value features nothing", () => {
    expect(tryLiveApis(" api_a, api_b ")).toEqual(["api_a", "api_b"]);
    expect(isLiveBuyApi("api_b", "api_a,api_b")).toBe(true);
    expect(tryLiveApis("")).toEqual([]);
  });
});
