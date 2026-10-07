import type { StoredUpstreamAuth } from "@hirakumi/core";
import { env } from "./env";
import type { PackSettlement } from "./settlement";

/** Why the DNS check passed or failed (apps/gateway/src/ownership.ts DnsReason). */
export type ChallengeReason = "verified" | "no_code" | "bad_host" | "timeout" | "unreachable" | "missing" | "mismatch";
/** The ownership check: one TXT lookup of `record` (_hirakumi.<host>), looking for the API's code. */
export type ChallengeCheck = { ok: boolean; reason: ChallengeReason; record: string; detail: string };
export type GatewayHealth = { health: "healthy" | "down"; checkedAt: string | null; lastReasons: string[] };

/** What one real call with a key said (apps/gateway/src/internal.ts check-key). */
export type KeyCheckClass =
  | "ok" | "accepted_unverified" | "refused" | "forbidden" | "rate_limited" | "timeout" | "echoed" | "unclear" | "unchecked";
/**
 * The gateway's check of a key: opened is false when it couldn't open the key at all; status is the API's HTTP
 * status, op the endpoint called, reasons the redacted test reasons, why says why nothing was called ("unchecked").
 * Never the answer's body.
 */
export type KeyCheck = {
  opened: boolean; class: KeyCheckClass; status?: number; op?: string; reasons?: string[]; why?: "not_proven" | "no_test_input" | "not_protected";
};
const KEY_CHECK_CLASSES: readonly string[] = [
  "ok", "accepted_unverified", "refused", "forbidden", "rate_limited", "timeout", "echoed", "unclear", "unchecked",
];

/** The check-key answer as the web app reads it, or null for any other shape. */
export function parseKeyCheck(value: unknown): KeyCheck | null {
  if (!value || typeof value !== "object") return null;
  const b = value as Record<string, unknown>;
  if (typeof b.opened !== "boolean") return null;
  // A key the gateway couldn't open was never called with, so it may come back without a class.
  const cls = b.class === undefined && !b.opened ? "unchecked" : b.class;
  if (typeof cls !== "string" || !KEY_CHECK_CLASSES.includes(cls)) return null;
  return {
    opened: b.opened,
    class: cls as KeyCheckClass,
    ...(typeof b.status === "number" ? { status: b.status } : {}),
    ...(typeof b.op === "string" ? { op: b.op } : {}),
    ...(Array.isArray(b.reasons) ? { reasons: b.reasons.filter((r): r is string => typeof r === "string") } : {}),
    ...(b.why === "not_proven" || b.why === "no_test_input" || b.why === "not_protected" ? { why: b.why } : {}),
  };
}

/** The front door (apps/gateway/src/frontDoorAdmin.ts). */
export type DomainStatus = "pending_dns" | "active" | "detached" | "disabled";
export type DnsTarget = { cname: string | null; a: string | null; aaaa: string | null };
export type FrontDoorView = {
  origin: string; publicHost: string | null;
  domain: { host: string; status: DomainStatus; txtVerifiedAt: string | null; routedAt: string | null; lastError: string | null } | null;
  dnsTarget: DnsTarget;
};
export type OriginTest = { opId: string; ok: boolean; detail: string };
/** The origin switch's answer: ok with the host now pending, or why not (the seller reads `detail`). */
export type OriginSwitch =
  | { ok: true; host: string; origin: string; tests: OriginTest[]; dnsTarget: DnsTarget }
  | { ok: false; status: number; error: string; detail: string; record?: string; code?: string; tests?: OriginTest[] };
export type DomainCheck = { ok: boolean; outcome: string; detail: string; chain: string[]; addresses: string[] };
export type Gateway = {
  checkChallenge(apiId: string): Promise<ChallengeCheck>;
  reloadApi(apiId: string): Promise<void>;
  getHealth(apiId: string): Promise<GatewayHealth>;
  /** How each pack settles now for a buyer who can escrow (the gateway's PACK_MODE and settlement policy). */
  getSettlement(apiId: string): Promise<PackSettlement[]>;
  /**
   * One real call to the seller's API with a key: the sealed candidate in stored, or the saved key without it.
   * Null on any failure, never throws. Optional so test fakes without it behave as before any check existed.
   */
  checkKey?(apiId: string, stored?: StoredUpstreamAuth): Promise<KeyCheck | null>;
};

/** The front door's internal routes, apart from Gateway so a test fakes only what it uses. */
export type FrontDoorGateway = {
  getFrontDoor(apiId: string): Promise<FrontDoorView>;
  /** The key sealed for the new origin: one key (hks2) or a key in several parts (hks3). */
  switchOrigin(apiId: string, body: { origin: string; upstreamAuth: StoredUpstreamAuth }): Promise<OriginSwitch>;
  checkDomain(host: string): Promise<DomainCheck>;
  stopFrontDoor(apiId: string): Promise<{ host: string | null }>;
  reloadDomain(host: string): Promise<void>;
};

/** `userMessage` is safe to show the seller; `message` is for logs. */
export class GatewayError extends Error {
  constructor(readonly userMessage: string, detail: string) {
    super(detail);
    this.name = "GatewayError";
  }
}

const UNREACHABLE = "We couldn't reach the Hirakumi checker. Try again in a minute.";
const UNREADABLE = "The Hirakumi checker sent an unreadable answer. Try again in a minute.";

export function createGateway(opts: { baseUrl: string; token: string; fetchImpl?: typeof fetch; timeoutMs?: number }): Gateway & FrontDoorGateway {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 20_000;

  async function call(method: "GET" | "POST", path: string, ms = timeoutMs, json?: unknown, passClientErrors = false): Promise<Response> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${opts.token}`, accept: "application/json",
          ...(json === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(json === undefined ? {} : { body: JSON.stringify(json) }),
        signal: AbortSignal.timeout(ms),
      });
    } catch (e) {
      throw new GatewayError(UNREACHABLE, `gateway ${method} ${path} failed: ${String(e)}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new GatewayError("Hirakumi's checker isn't set up correctly right now. Try again later.", `gateway ${path} -> ${res.status} (check INTERNAL_TOKEN)`);
    }
    if (passClientErrors && res.status >= 400 && res.status < 500) return res;
    if (!res.ok) throw new GatewayError("The Hirakumi checker had a problem. Try again in a minute.", `gateway ${path} -> ${res.status}`);
    return res;
  }

  async function body(res: Response, path: string): Promise<Record<string, unknown>> {
    try {
      const value: unknown = await res.json();
      if (value && typeof value === "object") return value as Record<string, unknown>;
    } catch {
      // fall through
    }
    throw new GatewayError(UNREADABLE, `gateway ${path} returned non-JSON`);
  }

  return {
    async checkChallenge(apiId) {
      const path = `/internal/challenge/${encodeURIComponent(apiId)}/check`;
      const b = await body(await call("POST", path), path);
      if (typeof b.ok !== "boolean" || typeof b.reason !== "string" || typeof b.record !== "string" || typeof b.detail !== "string") {
        throw new GatewayError(UNREADABLE, `gateway ${path} returned an unexpected shape`);
      }
      return { ok: b.ok, reason: b.reason as ChallengeReason, record: b.record, detail: b.detail };
    },
    async reloadApi(apiId) {
      await call("POST", `/internal/apis/${encodeURIComponent(apiId)}/reload`);
    },
    async getHealth(apiId) {
      const path = `/internal/apis/${encodeURIComponent(apiId)}/health`;
      const b = await body(await call("GET", path), path);
      if (b.health !== "healthy" && b.health !== "down") throw new GatewayError(UNREADABLE, `gateway ${path} bad health`);
      return {
        health: b.health,
        checkedAt: typeof b.checkedAt === "string" ? b.checkedAt : null,
        lastReasons: Array.isArray(b.lastReasons) ? b.lastReasons.filter((r): r is string => typeof r === "string") : [],
      };
    },
    async getSettlement(apiId) {
      const path = `/internal/apis/${encodeURIComponent(apiId)}/settlement`;
      // A public page waits on this: a short timeout, and the caller leaves the line out on any error.
      const b = await body(await call("GET", path, 3_000), path);
      if (!Array.isArray(b.packs)) throw new GatewayError(UNREADABLE, `gateway ${path} bad settlement`);
      const mode = (v: unknown) => (v === "direct" || v === "escrow" ? v : null);
      return b.packs.flatMap((p: Record<string, unknown>) => {
        const m = mode(p?.mode);
        if (typeof p?.packId !== "string" || !m || !Array.isArray(p.reasons)) return [];
        const recommended = mode(p.recommended);
        return [{
          packId: p.packId, mode: m, reasons: p.reasons.filter((r): r is string => typeof r === "string"),
          ...(recommended ? { recommended } : {}),
        }];
      });
    },
    async checkKey(apiId, stored) {
      const path = `/internal/apis/${encodeURIComponent(apiId)}/check-key`;
      try {
        // The gateway's own call to the seller's API may take up to 15 s; 25 s leaves room for opening and the trip.
        return parseKeyCheck(await body(await call("POST", path, 25_000, stored === undefined ? {} : { stored }), path));
      } catch (e) {
        console.warn(`gateway key check failed for ${apiId}`, e instanceof Error ? e.message : e);
        return null;
      }
    },
    async getFrontDoor(apiId) {
      const path = `/internal/front-door/${encodeURIComponent(apiId)}`;
      const b = await body(await call("GET", path, 5_000), path);
      if (typeof b.origin !== "string" || !b.dnsTarget) throw new GatewayError(UNREADABLE, `gateway ${path} bad front door`);
      return b as unknown as FrontDoorView;
    },
    async switchOrigin(apiId, payload) {
      const path = `/internal/front-door/${encodeURIComponent(apiId)}/origin`;
      // Test calls to the new origin run first: up to 15 s each.
      const res = await call("POST", path, 90_000, payload, true);
      const b = await body(res, path);
      if (b.ok === true) return b as unknown as OriginSwitch;
      return {
        ok: false, status: res.status, error: typeof b.error === "string" ? b.error : "failed",
        detail: typeof b.detail === "string" ? b.detail : "The new origin could not be set up.",
        ...(typeof b.record === "string" ? { record: b.record } : {}),
        ...(typeof b.code === "string" ? { code: b.code } : {}),
        ...(Array.isArray(b.tests) ? { tests: b.tests as OriginTest[] } : {}),
      };
    },
    async checkDomain(host) {
      const path = `/internal/domains/${encodeURIComponent(host)}/check`;
      const res = await call("POST", path, 30_000, {}, true);
      const b = await body(res, path);
      if (res.status === 404) return { ok: false, outcome: "not_found", detail: "This hostname is not set up for the front door.", chain: [], addresses: [] };
      if (typeof b.ok !== "boolean" || typeof b.detail !== "string") throw new GatewayError(UNREADABLE, `gateway ${path} bad check`);
      return {
        ok: b.ok, outcome: String(b.outcome ?? ""), detail: b.detail,
        chain: Array.isArray(b.chain) ? b.chain.map(String) : [], addresses: Array.isArray(b.addresses) ? b.addresses.map(String) : [],
      };
    },
    async stopFrontDoor(apiId) {
      const path = `/internal/front-door/${encodeURIComponent(apiId)}/stop`;
      const b = await body(await call("POST", path, 10_000, {}), path);
      return { host: typeof b.host === "string" ? b.host : null };
    },
    async reloadDomain(host) {
      await call("POST", `/internal/domains/${encodeURIComponent(host)}/reload`, 5_000);
    },
  };
}

let override: Gateway | null = null;
let frontDoorOverride: FrontDoorGateway | null = null;

export function setGatewayForTests(g: Gateway | null): void {
  override = g;
}

export function setFrontDoorGatewayForTests(g: FrontDoorGateway | null): void {
  frontDoorOverride = g;
}

export function getGateway(): Gateway {
  return override ?? createGateway({ baseUrl: env.gatewayInternalUrl(), token: env.internalToken() });
}

/**
 * The gateway's check of a key (Gateway.checkKey), or null when it couldn't run: no gateway configured, a gateway
 * without the check, or any failure. A null check never blocks a save.
 */
export async function checkKey(apiId: string, stored?: StoredUpstreamAuth): Promise<KeyCheck | null> {
  try {
    const gw = getGateway();
    return gw.checkKey ? await gw.checkKey(apiId, stored) : null;
  } catch (e) {
    console.warn(`gateway key check failed for ${apiId}`, e instanceof Error ? e.message : e);
    return null;
  }
}

export function getFrontDoorGateway(): FrontDoorGateway {
  return frontDoorOverride ?? createGateway({ baseUrl: env.gatewayInternalUrl(), token: env.internalToken() });
}

/** The gateway forgets a front-door host now (retire, delete): no certificate and 421 from the next request. */
export async function reloadDomainQuietly(host: string): Promise<void> {
  try {
    await getFrontDoorGateway().reloadDomain(host);
  } catch (e) {
    console.warn(`gateway domain reload failed for ${host}`, e);
  }
}

/** Cache invalidation after a seller change; failure must never block the seller's click. */
export async function reloadQuietly(apiId: string): Promise<void> {
  try {
    await getGateway().reloadApi(apiId);
  } catch (e) {
    console.warn(`gateway reload failed for ${apiId}`, e);
  }
}
