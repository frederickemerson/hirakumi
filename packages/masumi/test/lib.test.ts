import { describe, expect, it } from "vitest";
import { intervalSeconds, jcsFlat, mip004, parseStartJob } from "../scripts/lib.js";

describe("script helpers", () => {
  it("mip004 hashes identifier;payload (known vector)", () => {
    expect(mip004("0123456789abcdef0123", jcsFlat({ symbol: "ADA", nonce: "n1" }))).toBe(
      "ffaf6b90e93a6b18b4fda9e58780d78e1fbd1194a0d5397fef24eccc155c56f1",
    );
  });

  it("jcsFlat sorts keys", () => {
    expect(jcsFlat({ symbol: "ADA", nonce: "n1" })).toBe('{"nonce":"n1","symbol":"ADA"}');
  });

  it("intervalSeconds summarises gaps between distinct check times", () => {
    expect(intervalSeconds(["2026-10-07T03:00:00Z", "2026-10-07T03:01:40Z", "2026-10-07T03:01:40Z", "2026-10-07T03:05:00Z"])).toEqual({
      count: 2,
      min: 100,
      median: 200,
      max: 200,
    });
    expect(intervalSeconds(["2026-10-07T03:00:00Z"])).toBeNull();
  });

  it("parseStartJob reads MIP-003 terms and unix-ms times", () => {
    const t = parseStartJob({
      job_id: "job_1",
      blockchainIdentifier: "bc_1",
      agentIdentifier: "a".repeat(120),
      sellerVKey: "c".repeat(56),
      input_hash: "b".repeat(64),
      identifierFromPurchaser: "0123456789abcdef0123",
      payByTime: 1_791_000_000_000,
      submitResultTime: "1791000600000",
      unlockTime: 1_791_001_560_000,
      externalDisputeUnlockTime: 1_791_002_520_000,
    });
    expect(t.jobId).toBe("job_1");
    expect(t.submitResultTime.getTime()).toBe(1_791_000_600_000);
    expect(() => parseStartJob({ job_id: "x" })).toThrow(/missing blockchainIdentifier/);
  });
});
