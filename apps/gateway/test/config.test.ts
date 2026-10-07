import { afterEach, describe, expect, it, vi } from "vitest";
import { generateUpstreamAuthKeys } from "@hirakumi/core";
import { estimatedDowntimeSeconds, loadConfig } from "../src/config";

const env = {
  DATABASE_URL: "postgres://x", PUBLIC_BASE_URL: "https://api.hirakumi.app/", INTERNAL_TOKEN: "change-me-32-bytes",
  FACILITATOR_URL: "https://x402.preprod.dev.ecosyseng.cf-deployments.org",
  // Hybrid is the default; with the fee address and the closer key it can also escrow.
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
  it("GATEWAY_PORT: blank means the default; anything but a port number 1-65535 is refused", () => {
    expect(loadConfig({ ...env, GATEWAY_PORT: "" }).port).toBe(4021);
    expect(loadConfig({ ...env, GATEWAY_PORT: " 8080 " }).port).toBe(8080);
    for (const bad of ["0", "abc", "70000", "80.5"]) expect(() => loadConfig({ ...env, GATEWAY_PORT: bad })).toThrow(/GATEWAY_PORT/);
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
  it("PACK_MODE defaults to hybrid and boots without escrow settings; escrow needs a fee address and a closer key", () => {
    expect(loadConfig(env)).toMatchObject({ packMode: "hybrid", packEscrow: { closerVkh: "cd".repeat(28) } });
    const bare = { ...env, HIRAKUMI_FEE_ADDRESS: "", ESCROW_CLOSER_VKH: "" };
    expect(loadConfig(bare)).toMatchObject({ packMode: "hybrid", packEscrow: null });
    expect(() => loadConfig({ ...bare, PACK_MODE: "escrow" })).toThrow(/HIRAKUMI_FEE_ADDRESS/);
    expect(loadConfig({ ...bare, PACK_MODE: "direct" })).toMatchObject({ packMode: "direct", packEscrow: null });
    const fee = "addr_test1vrl0alh7lml0alh7lml0alh7lml0alh7lml0alh7lml0alsu6gx0s";
    expect(() => loadConfig({ ...bare, PACK_MODE: "escrow", HIRAKUMI_FEE_ADDRESS: fee })).toThrow(/OPERATOR_MNEMONIC/);
    const c = loadConfig({ ...bare, DEMO_MODE: "1", PACK_MODE: "escrow", HIRAKUMI_FEE_ADDRESS: fee, ESCROW_CLOSER_VKH: "AB".repeat(28) });
    expect(c.packEscrow).toMatchObject({
      feeAddress: fee, feeBps: 300, closerVkh: "ab".repeat(28), contestPeriodMs: 180_000, closeFeeBudgetLovelace: 700_000, operatorMnemonic: null,
    });
    expect(() => loadConfig({ ...env, PACK_MODE: "both" })).toThrow(/PACK_MODE/);
  });
  it("PACK_MODE=hybrid: escrow settings when all are set, else none (hybrid then settles direct)", () => {
    const fee = "addr_test1vrl0alh7lml0alh7lml0alh7lml0alh7lml0alh7lml0alsu6gx0s";
    const bare = { ...env, HIRAKUMI_FEE_ADDRESS: "", ESCROW_CLOSER_VKH: "" };
    expect(loadConfig({ ...bare, PACK_MODE: "hybrid" })).toMatchObject({ packMode: "hybrid", packEscrow: null });
    expect(loadConfig({ ...bare, PACK_MODE: "hybrid", HIRAKUMI_FEE_ADDRESS: fee })).toMatchObject({ packMode: "hybrid", packEscrow: null });
    const c = loadConfig({ ...env, PACK_MODE: "hybrid", HIRAKUMI_FEE_ADDRESS: fee, ESCROW_CLOSER_VKH: "ab".repeat(28) });
    expect(c.packEscrow).toMatchObject({ feeAddress: fee, closerVkh: "ab".repeat(28) });
    // Set but wrong is a mistake, not a missing prerequisite.
    expect(() => loadConfig({ ...env, PACK_MODE: "hybrid", HIRAKUMI_FEE_ADDRESS: "addr1qmainnet", ESCROW_CLOSER_VKH: "ab".repeat(28) })).toThrow(/HIRAKUMI_FEE_ADDRESS/);
    expect(() => loadConfig({ ...env, PACK_MODE: "hybrid", HIRAKUMI_FEE_ADDRESS: fee, ESCROW_CLOSER_VKH: "xyz" })).toThrow(/ESCROW_CLOSER_VKH/);
  });
  it("settlement thresholds: 2 tUSDM, 99%, 7 days by default; each overridable; nonsense refused", () => {
    expect(loadConfig(env).settlement).toEqual({ escrowFromMicros: 2_000_000n, minUptimePct: 99, minListingDays: 7 });
    expect(loadConfig({ ...env, SETTLEMENT_ESCROW_FROM_MICROS: "5000000", SETTLEMENT_MIN_UPTIME_PCT: "99.5", SETTLEMENT_MIN_LISTING_DAYS: "3" }).settlement)
      .toEqual({ escrowFromMicros: 5_000_000n, minUptimePct: 99.5, minListingDays: 3 });
    expect(() => loadConfig({ ...env, SETTLEMENT_ESCROW_FROM_MICROS: "2.5" })).toThrow(/SETTLEMENT_ESCROW_FROM_MICROS/);
    expect(() => loadConfig({ ...env, SETTLEMENT_MIN_UPTIME_PCT: "101" })).toThrow(/SETTLEMENT_MIN_UPTIME_PCT/);
    expect(() => loadConfig({ ...env, SETTLEMENT_MIN_LISTING_DAYS: "-1" })).toThrow(/SETTLEMENT_MIN_LISTING_DAYS/);
  });
});

describe("loadConfig: the upstream-auth key pair", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const keys = generateUpstreamAuthKeys();
  const other = generateUpstreamAuthKeys();

  it("a private key matching the public key is kept", () => {
    const c = loadConfig({ ...env, UPSTREAM_AUTH_PRIVATE_KEY: keys.privateKey, UPSTREAM_AUTH_PUBLIC_KEY: ` ${keys.publicKey} ` });
    expect(c).toMatchObject({ upstreamAuthPrivateKey: keys.privateKey, upstreamAuthKeyProblem: null });
  });

  it("a mismatched or unparseable private key is not used, is logged, and never stops the gateway", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(loadConfig({ ...env, UPSTREAM_AUTH_PRIVATE_KEY: other.privateKey, UPSTREAM_AUTH_PUBLIC_KEY: keys.publicKey }))
      .toMatchObject({ upstreamAuthPrivateKey: null, upstreamAuthKeyProblem: "mismatch" });
    for (const bad of ["not-a-key", Buffer.from("garbage bytes").toString("base64")]) {
      expect(loadConfig({ ...env, UPSTREAM_AUTH_PRIVATE_KEY: bad, UPSTREAM_AUTH_PUBLIC_KEY: keys.publicKey }))
        .toMatchObject({ upstreamAuthPrivateKey: null, upstreamAuthKeyProblem: "unparseable" });
    }
    expect(err).toHaveBeenCalledTimes(3);
    for (const [line] of err.mock.calls) expect(String(line)).not.toContain(other.privateKey);
  });

  it("without a public key the private key is used as before; without either, keys are off", () => {
    expect(loadConfig({ ...env, UPSTREAM_AUTH_PRIVATE_KEY: keys.privateKey }))
      .toMatchObject({ upstreamAuthPrivateKey: keys.privateKey, upstreamAuthKeyProblem: null });
    expect(loadConfig({ ...env, UPSTREAM_AUTH_PUBLIC_KEY: keys.publicKey }))
      .toMatchObject({ upstreamAuthPrivateKey: null, upstreamAuthKeyProblem: null });
    expect(loadConfig(env)).toMatchObject({ upstreamAuthPrivateKey: null, upstreamAuthKeyProblem: null });
  });
});
