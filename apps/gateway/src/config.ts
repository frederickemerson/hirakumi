import { isIP } from "node:net";
import { DEFAULT_SETTLEMENT_POLICY, type SettlementPolicy } from "@hirakumi/core";
import { walletKeys } from "@hirakumi/escrow/txs";
import type { HealthThresholds } from "./health";

export type { HealthThresholds } from "./health";
export type GatewayConfig = {
  port: number;
  publicBaseUrl: string;
  internalToken: string;
  demoMode: boolean;
  facilitatorUrl: string;
  databaseUrl: string;
  probeIntervalMs: number;
  /** How often an API proven with the X-Hirakumi-Verify header is checked again (jittered by 10%). */
  ownershipRecheckMs: number;
  /** How soon it is checked again after a failed or unreachable check, so two failures in a row come quickly. */
  ownershipRetryMs: number;
  thresholds: HealthThresholds;
  l1Confirmations: number;
  upstreamTimeoutMs: number;
  escrow: { payByMs: number; submitResultMs: number; unit: string };
  blockfrostProjectId: string | null;
  masumi: { baseUrl: string; token: string } | null;
  /**
   * `hybrid` (default): the settlement policy picks per purchase (packages/core settlement.ts); without
   * packEscrow it settles direct. `direct`: packs pay the seller. `escrow`: packs lock at the pack_escrow script.
   */
  packMode: PackMode;
  packEscrow: PackEscrowConfig | null;
  /** PACK_MODE=hybrid thresholds: SETTLEMENT_ESCROW_FROM_MICROS, SETTLEMENT_MIN_UPTIME_PCT, SETTLEMENT_MIN_LISTING_DAYS. */
  settlement: SettlementPolicy;
  /**
   * START_JOB_TRUSTED_CIDRS: source ranges of Sokosumi's backend / Masumi purchaser nodes. MIP-003 start_job carries
   * no signature or key (Sokosumi sends only Content-Type), so the address Caddy saw is the only signal. Callers in
   * these ranges get START_JOB_TRUSTED_LIMIT per minute per address instead of 10. Normalised, empty by default.
   */
  startJobTrustedCidrs: string[];
  /**
   * TRY_LIVE_APIS: the featured APIs the demo wallet may buy live packs for (comma list). A live purchase pays
   * the seller from Hirakumi's wallet, so any other API is refused; otherwise anyone could list an API and drain it.
   */
  tryLiveApis: string[];
  /**
   * UPSTREAM_AUTH_PRIVATE_KEY: opens the keys sellers give for APIs that need one (base64 PKCS#8 X25519, made with
   * `pnpm --filter @hirakumi/gateway upstream-auth-keys`; the web app gets the public half). Unset: such APIs are blocked.
   */
  upstreamAuthPrivateKey: string | null;
};

export type PackMode = "direct" | "escrow" | "hybrid";

export const DEFAULT_TRY_LIVE_APIS = ["api_eejiaioyqt"];

/** "a, b" to ["a", "b"]; unset gives the default featured list; an empty string gives none. */
export function parseTryLiveApis(raw: string | undefined): string[] {
  if (raw === undefined) return [...DEFAULT_TRY_LIVE_APIS];
  return [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
}

export type PackEscrowConfig = {
  feeAddress: string;
  feeBps: number;
  /** Payment key hash written into every datum as `closer`. */
  closerVkh: string;
  contestPeriodMs: number;
  closeFeeBudgetLovelace: number;
  /** Signs Close / Raise / Settle. Unset → the ChannelWatcher only verifies locks and tracks status. */
  operatorMnemonic: string | null;
  /** A paid call's lease on the unsigned allowance expires after this if the process dies mid-call. */
  leaseSeconds: number;
  /** Raise only while at least this much of the contest period is left. */
  raiseMarginMs: number;
};

export const MASUMI_ESCROW_UNIT_PREPROD =
  "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const required = (k: string): string => {
    const v = env[k]?.trim();
    if (!v) throw new Error(`Set ${k} in the environment (see .env.example)`);
    return v;
  };
  const demoMode = env.DEMO_MODE === "1";
  const internalToken = required("INTERNAL_TOKEN");
  if (internalToken.length < 16) throw new Error("INTERNAL_TOKEN must be at least 16 characters");
  const psUrl = env.PAYMENT_SERVICE_URL?.trim();
  const psToken = env.PAYMENT_SERVICE_TOKEN?.trim();
  return {
    port: parsePort(env.GATEWAY_PORT),
    publicBaseUrl: required("PUBLIC_BASE_URL").replace(/\/+$/, ""),
    internalToken,
    demoMode,
    facilitatorUrl: required("FACILITATOR_URL"),
    databaseUrl: required("DATABASE_URL"),
    probeIntervalMs: demoMode ? 10_000 : 120_000,
    ownershipRecheckMs: 6 * 3_600_000,
    ownershipRetryMs: 15 * 60_000,
    thresholds: demoMode ? { failsToDown: 2, passesToHeal: 2 } : { failsToDown: 3, passesToHeal: 2 },
    // Spec §8: block inclusion. Task 0 confirms the hosted facilitator range includes 0.
    l1Confirmations: 0,
    upstreamTimeoutMs: 15_000,
    // Masumi payment-service rules (x402-cardano-demo/masumi/src/masumi.ts): pay-by ≥ 5 min before
    // submit-result; submit-result ≥ 15 min ahead. Demo uses the shortest safe values.
    escrow: {
      ...(demoMode ? { payByMs: 10 * 60_000, submitResultMs: 20 * 60_000 } : { payByMs: 30 * 60_000, submitResultMs: 60 * 60_000 }),
      // Contract: the Masumi escrow tUSDM (not the x402 one). Reported in start_job `amounts` (v1.1 G7).
      unit: env.MASUMI_ESCROW_UNIT?.trim() || MASUMI_ESCROW_UNIT_PREPROD,
    },
    blockfrostProjectId: env.BLOCKFROST_PROJECT_ID?.trim() || null,
    masumi: psUrl && psToken ? { baseUrl: psUrl, token: psToken } : null,
    ...packEscrowFrom(env, demoMode),
    settlement: settlementFrom(env),
    startJobTrustedCidrs: parseTrustedCidrs(env.START_JOB_TRUSTED_CIDRS),
    tryLiveApis: parseTryLiveApis(env.TRY_LIVE_APIS),
    upstreamAuthPrivateKey: env.UPSTREAM_AUTH_PRIVATE_KEY?.trim() || null,
  };
}

/** GATEWAY_PORT: blank or unset is 4021. Number("") is 0 (a random port) and Number("x") is NaN, so check the text. */
function parsePort(raw: string | undefined): number {
  const v = raw?.trim() ?? "";
  if (!v) return 4021;
  const n = /^\d{1,5}$/.test(v) ? Number(v) : NaN;
  if (!(n >= 1 && n <= 65_535)) throw new Error(`GATEWAY_PORT must be a port number from 1 to 65535, not "${v}"`);
  return n;
}

/** "a.b.c.d/n, x:y::/n, a.b.c.d" → normalised CIDRs. A bare address is a /32 or /128. /0 is refused (trusts everyone). */
export function parseTrustedCidrs(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const item of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^([^/]+)(?:\/(\d{1,3}))?$/.exec(item);
    const family = m ? isIP(m[1]) : 0;
    const max = family === 6 ? 128 : 32;
    const prefix = m?.[2] === undefined ? max : Number(m[2]);
    if (!m || family === 0 || prefix < 1 || prefix > max) {
      throw new Error(`START_JOB_TRUSTED_CIDRS: "${item}" is not an IPv4 or IPv6 CIDR (prefix 1-32 or 1-128)`);
    }
    out.push(`${m[1].toLowerCase()}/${prefix}`);
  }
  return out;
}

function packEscrowFrom(env: NodeJS.ProcessEnv, demoMode: boolean): Pick<GatewayConfig, "packMode" | "packEscrow"> {
  // Hybrid is the default: the settlement policy picks direct or escrow per purchase. direct and escrow stay explicit.
  const mode = env.PACK_MODE?.trim() || "hybrid";
  if (mode !== "direct" && mode !== "escrow" && mode !== "hybrid") throw new Error("PACK_MODE must be direct, escrow or hybrid");
  if (mode === "direct") return { packMode: "direct", packEscrow: null };
  const feeAddress = env.HIRAKUMI_FEE_ADDRESS?.trim();
  const operatorMnemonic = env.OPERATOR_MNEMONIC?.trim() || null;
  const closerHex = env.ESCROW_CLOSER_VKH?.trim().toLowerCase();
  // Hybrid without escrow settings still runs: every pack settles direct and the 402 says what the policy recommended.
  if (mode === "hybrid" && (!feeAddress || (!operatorMnemonic && !closerHex))) {
    console.warn("[config] PACK_MODE=hybrid without HIRAKUMI_FEE_ADDRESS and OPERATOR_MNEMONIC or ESCROW_CLOSER_VKH: every pack settles direct");
    return { packMode: "hybrid", packEscrow: null };
  }
  if (!feeAddress?.startsWith("addr_test1")) throw new Error(`PACK_MODE=${mode} needs HIRAKUMI_FEE_ADDRESS (a preprod address)`);
  const closerVkh = (operatorMnemonic ? walletKeys(operatorMnemonic).vkh : closerHex) ?? "";
  if (!/^[0-9a-f]{56}$/.test(closerVkh)) throw new Error(`PACK_MODE=${mode} needs OPERATOR_MNEMONIC or ESCROW_CLOSER_VKH (28-byte hex)`);
  const int = (k: string, dflt: number) => {
    const v = env[k]?.trim();
    if (!v) return dflt;
    if (!/^\d+$/.test(v)) throw new Error(`${k} must be a whole number`);
    return Number(v);
  };
  return {
    packMode: mode,
    packEscrow: {
      feeAddress, closerVkh, operatorMnemonic,
      feeBps: int("HIRAKUMI_FEE_BPS", 300),
      contestPeriodMs: int("CONTEST_PERIOD_MS", demoMode ? 180_000 : 3_600_000),
      closeFeeBudgetLovelace: int("CLOSE_FEE_BUDGET_LOVELACE", 700_000),
      leaseSeconds: 30,
      raiseMarginMs: 60_000,
    },
  };
}

function settlementFrom(env: NodeJS.ProcessEnv): SettlementPolicy {
  const d = DEFAULT_SETTLEMENT_POLICY;
  const num = (k: string, ok: (n: number) => boolean, what: string): number | null => {
    const v = env[k]?.trim();
    if (!v) return null;
    const n = Number(v);
    if (!/^\d+(\.\d+)?$/.test(v) || !ok(n)) throw new Error(`${k} must be ${what}`);
    return n;
  };
  const micros = env.SETTLEMENT_ESCROW_FROM_MICROS?.trim();
  if (micros && !/^\d+$/.test(micros)) throw new Error("SETTLEMENT_ESCROW_FROM_MICROS must be a whole number of micros");
  return {
    escrowFromMicros: micros ? BigInt(micros) : d.escrowFromMicros,
    minUptimePct: num("SETTLEMENT_MIN_UPTIME_PCT", (n) => n <= 100, "a percentage from 0 to 100") ?? d.minUptimePct,
    minListingDays: num("SETTLEMENT_MIN_LISTING_DAYS", () => true, "a number of days") ?? d.minListingDays,
  };
}

export function estimatedDowntimeSeconds(c: Pick<GatewayConfig, "probeIntervalMs" | "thresholds">): number {
  return Math.ceil(c.probeIntervalMs / 1000) * c.thresholds.passesToHeal;
}
