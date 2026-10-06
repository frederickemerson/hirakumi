import { env } from "./env";

export type ChallengeCheck = { ok: boolean; triedUrl: string; detail: string };
export type GatewayHealth = { health: "healthy" | "down"; checkedAt: string | null; lastReasons: string[] };
export type Gateway = {
  checkChallenge(apiId: string): Promise<ChallengeCheck>;
  reloadApi(apiId: string): Promise<void>;
  getHealth(apiId: string): Promise<GatewayHealth>;
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

  async function call(method: "GET" | "POST", path: string): Promise<Response> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${opts.token}`, accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
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
      if (typeof b.ok !== "boolean" || typeof b.triedUrl !== "string" || typeof b.detail !== "string") {
        throw new GatewayError(UNREADABLE, `gateway ${path} returned an unexpected shape`);
      }
      return { ok: b.ok, triedUrl: b.triedUrl, detail: b.detail };
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
  };
}

let override: Gateway | null = null;

export function setGatewayForTests(g: Gateway | null): void {
  override = g;
}

export function getGateway(): Gateway {
  return override ?? createGateway({ baseUrl: env.gatewayInternalUrl(), token: env.internalToken() });
}

/** Cache invalidation after a seller change; failure must never block the seller's click. */
export async function reloadQuietly(apiId: string): Promise<void> {
  try {
    await getGateway().reloadApi(apiId);
  } catch (e) {
    console.warn(`gateway reload failed for ${apiId}`, e);
  }
}
