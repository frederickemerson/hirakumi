import { describe, expect, it } from "vitest";
import { API_STATES } from "./types";
import {
  cardanoscanTxUrl, formatTime, healthLabel, JOB_STATUS_LABEL, PACK_STATUS_LABEL, plural, shortAddress,
  STATE_LABEL, STEP_STATUS_LABEL,
} from "./copy";

describe("copy", () => {
  it("has a plain-English label for every API state", () => {
    for (const s of API_STATES) expect(STATE_LABEL[s]).toMatch(/\S/);
  });

  it("never uses jargon the copy rule forbids", () => {
    const all = [
      ...Object.values(STATE_LABEL), ...Object.values(STEP_STATUS_LABEL),
      ...Object.values(PACK_STATUS_LABEL), ...Object.values(JOB_STATUS_LABEL),
    ];
    for (const text of all) expect(text).not.toMatch(/\b(rule|acceptance|x402|lovelace|micros)\b/i);
  });

  it("says Live or Down for health", () => {
    expect(healthLabel("healthy")).toBe("Live");
    expect(healthLabel("down")).toBe("Down");
  });

  it("links transactions to preprod Cardanoscan", () => {
    expect(cardanoscanTxUrl("abc123")).toBe("https://preprod.cardanoscan.io/transaction/abc123");
  });

  it("shortens long addresses", () => {
    expect(shortAddress("addr_test1qqqqqqqqqqqqqqqqqqqqqqqqqqqqzzzzzz")).toBe("addr_test1qq…zzzzzz");
  });

  it("shows times in UTC, labelled UTC, like the status page (QA 14)", () => {
    expect(formatTime("2026-10-06T23:30:00Z")).toBe("6 Oct 2026, 23:30 UTC");
    expect(formatTime(new Date("2026-10-07T01:05:00Z"))).toBe("7 Oct 2026, 01:05 UTC");
  });

  it("pluralises counts (QA 15)", () => {
    expect(plural(1, "call")).toBe("1 call");
    expect(plural(2, "call")).toBe("2 calls");
    expect(plural(0, "credit")).toBe("0 credits");
  });
});
