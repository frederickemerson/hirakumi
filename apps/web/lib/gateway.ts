import type { StoredUpstreamAuth } from "@hirakumi/core";
import { env } from "./env";
import type { PackSettlement } from "./settlement";

/** Why the header check passed or failed (apps/gateway/src/internal.ts OwnershipReason). */
export type ChallengeReason =
  | "verified" | "no_code" | "bad_url" | "blocked" | "timeout" | "unreachable" | "too_large" | "missing" | "mismatch";
/**
 * The ownership check: one GET to the API's base URL, looking for the X-Hirakumi-Verify header. triedUrl is that
 * base URL; status is the HTTP status when the request got one (any status may carry the header).
 */
export type ChallengeCheck = { ok: boolean; reason: ChallengeReason; triedUrl: string; detail: string; status?: number };
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
  opened: boolean; class: KeyCheckClass; status?: number; op?: string; reasons?: string[]; why?: "not_proven" | "no_test_input";
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
    ...(b.why === "not_proven" || b.why === "no_test_input" ? { why: b.why } : {}),
  };
}

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

/** `userMessage` is safe to show the seller; `message` is for logs. */
export class GatewayError extends Error {
  constructor(readonly userMessage: string, detail: string) {
    super(detail);
    this.name = "GatewayError";
  }
}

const UNREACHABLE = "We couldn't reach the Hirakumi checker. Try again in a minute.";
const UNREADABLE = "The Hirakumi checker sent an unreadable answer. Try again in a minute.";

export function createGateway(opts: { baseUrl: string; token: string; fetchImpl?: typeof fetch; timeoutMs?: number }): Gateway {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 20_000;

  async function call(method: "GET" | "POST", path: string, ms = timeoutMs, jsonBody?: unknown): Promise<Response> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${opts.token}`, accept: "application/json",
          ...(jsonBody === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(jsonBody === undefined ? {} : { body: JSON.stringify(jsonBody) }),
        signal: AbortSignal.timeout(ms),
      });
    } catch (e) {
      throw new GatewayError(UNREACHABLE, `gateway ${method} ${path} failed: ${String(e)}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new GatewayError("Hirakumi's checker isn't set up correctly right now. Try again later.", `gateway ${path} -> ${res.status} (check INTERNAL_TOKEN)`);
    }
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
      if (typeof b.ok !== "boolean" || typeof b.reason !== "string" || typeof b.triedUrl !== "string" || typeof b.detail !== "string") {
        throw new GatewayError(UNREADABLE, `gateway ${path} returned an unexpected shape`);
      }
      return {
        ok: b.ok, reason: b.reason as ChallengeReason, triedUrl: b.triedUrl, detail: b.detail,
        ...(typeof b.status === "number" ? { status: b.status } : {}),
      };
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
  };
}

let override: Gateway | null = null;

export function setGatewayForTests(g: Gateway | null): void {
  override = g;
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

/** Cache invalidation after a seller change; failure must never block the seller's click. */
export async function reloadQuietly(apiId: string): Promise<void> {
  try {
    await getGateway().reloadApi(apiId);
  } catch (e) {
    console.warn(`gateway reload failed for ${apiId}`, e);
  }
}
