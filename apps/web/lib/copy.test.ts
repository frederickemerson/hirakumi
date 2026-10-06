import { describe, expect, it } from "vitest";
import { API_STATES } from "./types";
import {
  cardanoscanTxUrl, healthLabel, humanizeStep, JOB_STATUS_LABEL, PACK_STATUS_LABEL, shortAddress,
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

  it("shortens long addresses and humanizes step names", () => {
    expect(shortAddress("addr_test1qqqqqqqqqqqqqqqqqqqqqqqqqqqqzzzzzz")).toBe("addr_test1qq…zzzzzz");
    expect(humanizeStep("qa_tests")).toBe("Qa tests");
  });
});
