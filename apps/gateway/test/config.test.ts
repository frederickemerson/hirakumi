import { describe, expect, it } from "vitest";
import { estimatedDowntimeSeconds, loadConfig } from "../src/config";

const env = {
  DATABASE_URL: "postgres://x", PUBLIC_BASE_URL: "https://api.hirakumi.app/", INTERNAL_TOKEN: "change-me-32-bytes",
  FACILITATOR_URL: "https://x402.preprod.dev.ecosyseng.cf-deployments.org",
  // Escrow packs are the default, so a working config names the fee address and the closer key.
  HIRAKUMI_FEE_ADDRESS: "addr_test1vrl0alh7lml0alh7lml0alh7lml0alh7lml0alh7lml0alsu6gx0s", ESCROW_CLOSER_VKH: "cd".repeat(28),
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
  it("TRY_LIVE_APIS: the featured demo API by default, else the comma list (audit I2)", () => {
    expect(loadConfig(env).tryLiveApis).toEqual(["api_eejiaioyqt"]);
    expect(loadConfig({ ...env, TRY_LIVE_APIS: " api_a, api_b ,api_a" }).tryLiveApis).toEqual(["api_a", "api_b"]);
    expect(loadConfig({ ...env, TRY_LIVE_APIS: "" }).tryLiveApis).toEqual([]);
  });
  it("START_JOB_TRUSTED_CIDRS: empty by default, a comma list of IPv4/IPv6 CIDRs, rejects anything else", () => {
    expect(loadConfig(env).startJobTrustedCidrs).toEqual([]);
    expect(loadConfig({ ...env, START_JOB_TRUSTED_CIDRS: " 203.0.113.0/24 , 2001:DB8::/32,192.0.2.7 " }).startJobTrustedCidrs)
      .toEqual(["203.0.113.0/24", "2001:db8::/32", "192.0.2.7/32"]);
    for (const bad of ["203.0.113.0/33", "2001:db8::/129", "example.com/24", "10.0.0.0/8x", "0.0.0.0/0", "::/0"]) {
      expect(() => loadConfig({ ...env, START_JOB_TRUSTED_CIDRS: bad })).toThrow(/START_JOB_TRUSTED_CIDRS/);
    }
  });
  it("names a missing variable", () => {
    expect(() => loadConfig({ ...env, FACILITATOR_URL: "" })).toThrow(/FACILITATOR_URL/);
  });
  it("reads Masumi settings only when both URL and token are set", () => {
    expect(loadConfig({ ...env, PAYMENT_SERVICE_URL: "http://ps/api/v1" }).masumi).toBeNull();
    expect(loadConfig({ ...env, PAYMENT_SERVICE_URL: "http://ps/api/v1", PAYMENT_SERVICE_TOKEN: "t" }).masumi)
      .toEqual({ baseUrl: "http://ps/api/v1", token: "t" });
  });
  it("PACK_MODE defaults to escrow, which needs a fee address and a closer key; direct stays as a fallback", () => {
    expect(loadConfig(env)).toMatchObject({ packMode: "escrow" });
    const bare = { ...env, HIRAKUMI_FEE_ADDRESS: "", ESCROW_CLOSER_VKH: "" };
    expect(() => loadConfig(bare)).toThrow(/HIRAKUMI_FEE_ADDRESS/);
    expect(loadConfig({ ...bare, PACK_MODE: "direct" })).toMatchObject({ packMode: "direct", packEscrow: null });
    const fee = "addr_test1vrl0alh7lml0alh7lml0alh7lml0alh7lml0alh7lml0alsu6gx0s";
    expect(() => loadConfig({ ...bare, PACK_MODE: "escrow", HIRAKUMI_FEE_ADDRESS: fee })).toThrow(/OPERATOR_MNEMONIC/);
    const c = loadConfig({ ...bare, DEMO_MODE: "1", PACK_MODE: "escrow", HIRAKUMI_FEE_ADDRESS: fee, ESCROW_CLOSER_VKH: "AB".repeat(28) });
    expect(c.packEscrow).toMatchObject({
      feeAddress: fee, feeBps: 300, closerVkh: "ab".repeat(28), contestPeriodMs: 180_000, closeFeeBudgetLovelace: 700_000, operatorMnemonic: null,
    });
    expect(() => loadConfig({ ...env, PACK_MODE: "both" })).toThrow(/PACK_MODE/);
  });
});
