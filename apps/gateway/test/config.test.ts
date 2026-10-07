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
  it("DNS_RESOLVERS: public resolvers by default, a comma list of IPs, and never a name", () => {
    expect(loadConfig(env).dnsResolvers).toEqual(["1.1.1.1", "8.8.8.8"]);
    expect(loadConfig({ ...env, DNS_RESOLVERS: " " }).dnsResolvers).toEqual(["1.1.1.1", "8.8.8.8"]);
    expect(loadConfig({ ...env, DNS_RESOLVERS: "9.9.9.9, 2620:fe::fe" }).dnsResolvers).toEqual(["9.9.9.9", "2620:fe::fe"]);
    expect(() => loadConfig({ ...env, DNS_RESOLVERS: "dns.google" })).toThrow(/DNS_RESOLVERS: "dns.google" is not an IP address/);
  });
  it("front door: EDGE_IPS (IPs only, default 52.70.235.103), WEB_BASE_URL (optional URL), TLS_ASK_PORT (default 4022)", () => {
    const c = loadConfig(env);
    expect(c).toMatchObject({ edgeIps: ["52.70.235.103"], webBaseUrl: null, tlsAskPort: 4022, domainRecheckMs: 6 * 3_600_000 });
    expect(loadConfig({ ...env, EDGE_IPS: "1.2.3.4, 2600:1F18::1,1.2.3.4" }).edgeIps).toEqual(["1.2.3.4", "2600:1f18::1"]);
    expect(() => loadConfig({ ...env, EDGE_IPS: "edge.example.com" })).toThrow(/EDGE_IPS/);
    expect(loadConfig({ ...env, WEB_BASE_URL: "https://hirakumi.vercel.app/" }).webBaseUrl).toBe("https://hirakumi.vercel.app");
    expect(() => loadConfig({ ...env, WEB_BASE_URL: "hirakumi" })).toThrow(/WEB_BASE_URL/);
    expect(() => loadConfig({ ...env, WEB_BASE_URL: "ftp://x.com" })).toThrow(/WEB_BASE_URL/);
    expect(loadConfig({ ...env, TLS_ASK_PORT: "5022" }).tlsAskPort).toBe(5022);
    expect(() => loadConfig({ ...env, TLS_ASK_PORT: "x" })).toThrow(/TLS_ASK_PORT/);
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

  it("an unparseable private key is not used; a mismatch is logged but the private key stays in use (audit 4)", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    // The gateway never uses UPSTREAM_AUTH_PUBLIC_KEY: a stale one must not take every keyed API Down.
    expect(loadConfig({ ...env, UPSTREAM_AUTH_PRIVATE_KEY: other.privateKey, UPSTREAM_AUTH_PUBLIC_KEY: keys.publicKey }))
      .toMatchObject({ upstreamAuthPrivateKey: other.privateKey, upstreamAuthKeyProblem: "mismatch" });
    for (const bad of ["not-a-key", Buffer.from("garbage bytes").toString("base64")]) {
      expect(loadConfig({ ...env, UPSTREAM_AUTH_PRIVATE_KEY: bad, UPSTREAM_AUTH_PUBLIC_KEY: keys.publicKey }))
        .toMatchObject({ upstreamAuthPrivateKey: null, upstreamAuthKeyProblem: "unparseable" });
    }
    expect(err).toHaveBeenCalledTimes(3);
    for (const [line] of err.mock.calls) expect(String(line)).not.toContain(other.privateKey.slice(-24));
  });

  it("without a public key the private key is used as before; without either, keys are off", () => {
    expect(loadConfig({ ...env, UPSTREAM_AUTH_PRIVATE_KEY: keys.privateKey }))
      .toMatchObject({ upstreamAuthPrivateKey: keys.privateKey, upstreamAuthKeyProblem: null });
    expect(loadConfig({ ...env, UPSTREAM_AUTH_PUBLIC_KEY: keys.publicKey }))
      .toMatchObject({ upstreamAuthPrivateKey: null, upstreamAuthKeyProblem: null });
    expect(loadConfig(env)).toMatchObject({ upstreamAuthPrivateKey: null, upstreamAuthKeyProblem: null });
  });
});
