import { describe, expect, it } from "vitest";
import { estimatedDowntimeSeconds, loadConfig } from "../src/config";

const env = {
  DATABASE_URL: "postgres://x", PUBLIC_BASE_URL: "https://api.hirakumi.app/", INTERNAL_TOKEN: "change-me-32-bytes",
  FACILITATOR_URL: "https://x402.preprod.dev.ecosyseng.cf-deployments.org",
};

describe("loadConfig", () => {
  it("production defaults: 120s, 3 fails, 2 passes, l1Confirmations 0, 15s upstream", () => {
    const c = loadConfig({ ...env, DEMO_MODE: "0" });
    expect(c).toMatchObject({
      port: 4021, publicBaseUrl: "https://api.hirakumi.app", demoMode: false, probeIntervalMs: 120_000,
      thresholds: { failsToDown: 3, passesToHeal: 2 }, l1Confirmations: 0, upstreamTimeoutMs: 15_000,
      blockfrostProjectId: null, masumi: null,
    });
    expect(estimatedDowntimeSeconds(c)).toBe(240);
  });
  it("demo mode: 10s, 2 fails, 2 passes", () => {
    const c = loadConfig({ ...env, DEMO_MODE: "1", GATEWAY_PORT: "5000" });
    expect(c).toMatchObject({ port: 5000, demoMode: true, probeIntervalMs: 10_000, thresholds: { failsToDown: 2, passesToHeal: 2 } });
    expect(estimatedDowntimeSeconds(c)).toBe(20);
  });
  it("names a missing variable", () => {
    expect(() => loadConfig({ ...env, FACILITATOR_URL: "" })).toThrow(/FACILITATOR_URL/);
  });
  it("reads Masumi settings only when both URL and token are set", () => {
    expect(loadConfig({ ...env, PAYMENT_SERVICE_URL: "http://ps/api/v1" }).masumi).toBeNull();
    expect(loadConfig({ ...env, PAYMENT_SERVICE_URL: "http://ps/api/v1", PAYMENT_SERVICE_TOKEN: "t" }).masumi)
      .toEqual({ baseUrl: "http://ps/api/v1", token: "t" });
  });
  it("PACK_MODE defaults to direct; escrow needs a fee address and a closer key", () => {
    expect(loadConfig(env)).toMatchObject({ packMode: "direct", packEscrow: null });
    expect(() => loadConfig({ ...env, PACK_MODE: "escrow" })).toThrow(/HIRAKUMI_FEE_ADDRESS/);
    const fee = "addr_test1vrl0alh7lml0alh7lml0alh7lml0alh7lml0alh7lml0alsu6gx0s";
    expect(() => loadConfig({ ...env, PACK_MODE: "escrow", HIRAKUMI_FEE_ADDRESS: fee })).toThrow(/OPERATOR_MNEMONIC/);
    const c = loadConfig({ ...env, DEMO_MODE: "1", PACK_MODE: "escrow", HIRAKUMI_FEE_ADDRESS: fee, ESCROW_CLOSER_VKH: "AB".repeat(28) });
    expect(c.packEscrow).toMatchObject({
      feeAddress: fee, feeBps: 300, closerVkh: "ab".repeat(28), contestPeriodMs: 180_000, closeFeeBudgetLovelace: 700_000, operatorMnemonic: null,
    });
    expect(() => loadConfig({ ...env, PACK_MODE: "both" })).toThrow(/PACK_MODE/);
  });
});
