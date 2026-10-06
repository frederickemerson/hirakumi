import { USDM_PREPROD_ASSET } from "@x402/cardano";
import type { FetchLike } from "../src/gatewayClient.js";

export const GW = "https://gw.test";
export const API = "api_demo";
export const TOKEN = "hk_test";
export const MASUMI_UNIT = "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d";
export type Mode = "pass" | "fail" | "down" | "pending" | "upstream_502";

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function fakeGateway(o: {
  modes?: Mode[];
  credits?: number;
  asset?: string;
  price?: string;
  chargeOnFail?: boolean;
  remainingHeaderOnRefusal?: boolean;
  downBeforePay?: boolean;
} = {}) {
  const state = { remaining: o.credits ?? 5, urls: [] as string[], modes: [...(o.modes ?? [])] };
  const fetch: FetchLike = async (url, init) => {
    state.urls.push(url);
    const auth = new Headers(init?.headers).get("authorization");
    if (!auth) {
      if (o.downBeforePay) return json(503, { status: "unavailable", message: "API is Down" });
      return json(402, {
        error: "credits_required",
        packs: [{ packId: "pk_demo", calls: o.credits ?? 5, price: o.price ?? "2000000", asset: o.asset ?? USDM_PREPROD_ASSET, buyUrl: `/a/${API}/packs/pk_demo` }],
        ruleHash: "sha256:abc",
        ruleUrl: "/r/sha256:abc",
      });
    }
    if (auth !== `Bearer ${TOKEN}`) return json(401, { error: "invalid_token", message: "unknown token" });
    const mode = state.modes.shift() ?? "pass";
    if (mode === "pending") return json(401, { error: "token_pending" });
    if (mode === "down") return json(503, { status: "unavailable", message: "API is Down" });
    if (mode === "fail" || mode === "upstream_502") {
      if (o.chargeOnFail) state.remaining--;
      const h: Record<string, string> = o.remainingHeaderOnRefusal ? { "X-Credits-Remaining": String(state.remaining) } : {};
      return mode === "fail"
        ? json(422, { error: "promise_not_met", reasons: ["/usd is required"] }, h)
        : json(502, { error: "upstream_error", reasons: ["upstream answered 500"] }, h);
    }
    if (state.remaining <= 0) return fetch(url, { ...init, headers: {} });
    state.remaining--;
    return json(200, { symbol: "ADA", usd: 0.27, change24h: 1.2, timestamp: "2026-10-06T08:00:00.000Z" }, { "X-Credits-Remaining": String(state.remaining) });
  };
  return { fetch, state };
}
