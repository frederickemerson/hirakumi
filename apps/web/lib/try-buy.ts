import { errorJson, sameOrigin } from "./http";
import { visitorKey } from "./try-handler";

/** A Cardano payment takes 20 to 60 s; past this something is wrong, and the purchase result is stored anyway. */
const TIMEOUT_MS = 110_000;

/**
 * ?resume=<purchaseId|latest>: where a pending purchase stands, never a new one. "" without it; null for a bad
 * value, which is refused, never dropped (dropping it would turn a status check into a purchase).
 */
function resumeQuery(req: Request): string | null {
  const v = new URL(req.url).searchParams.get("resume");
  if (v === null) return "";
  return /^(latest|try_[A-Za-z0-9_-]{1,64})$/.test(v) ? `?resume=${v}` : null;
}

/**
 * "Buy a pack live": asks the gateway (server-side, with INTERNAL_TOKEN) to buy a real pack from Hirakumi's
 * demo wallet and passes its progress stream through. The wallet's key and every limit live on the gateway.
 */
export function createBuyHandler(d: {
  gatewayInternalUrl: string;
  internalToken: string;
  allow: (key: string) => boolean;
  /** The gateway route; default the public showcase's. A seller's free test uses /internal/demo/self-test. */
  gatewayPath?: (apiId: string) => string;
  fetchImpl?: typeof fetch;
}) {
  const path = d.gatewayPath ?? ((apiId: string) => `/internal/demo/buy-pack/${encodeURIComponent(apiId)}`);
  const doFetch = d.fetchImpl ?? fetch;
  return async (req: Request, apiId: string): Promise<Response> => {
    if (!sameOrigin(req)) return errorJson(403, "Cross-site request refused.");
    const resume = resumeQuery(req);
    if (resume === null) return errorJson(400, "resume must be a purchase id or latest.");
    if (!d.allow(visitorKey(req))) return errorJson(429, "One purchase at a time, please. Wait a moment and try again.");
    let res: Response;
    try {
      res = await doFetch(`${d.gatewayInternalUrl.replace(/\/+$/, "")}${path(apiId)}${resume}`, {
        method: "POST",
        headers: { authorization: `Bearer ${d.internalToken}`, accept: "application/x-ndjson" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return errorJson(502, "We couldn't reach the Hirakumi gateway. Try again in a minute.");
    }
    if (res.status === 401) return errorJson(503, "Live purchase isn't set up correctly right now. Try again later.");
    if (!res.ok || !res.body) {
      const b = (await res.json().catch(() => null)) as { message?: unknown } | null;
      return errorJson(res.status >= 400 ? res.status : 502, typeof b?.message === "string" ? b.message : `The purchase failed (HTTP ${res.status}).`);
    }
    return new Response(res.body, { status: 200, headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
  };
}
