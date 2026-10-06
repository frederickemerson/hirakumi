import { errorJson, json, readJson } from "./http";
import { buildGatewayCall, describeTryResult } from "./try";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const MAX_BODY_CHARS = 20_000;
const TIMEOUT_MS = 25_000;

export type TryDeps = {
  gatewayBase: string;
  /** apiId → demo credit token */
  tokens: Record<string, string>;
  /** false = this visitor called too recently */
  allow: (key: string) => boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

function visitorKey(req: Request): string {
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
}

function parseBody(text: string): unknown {
  const clipped = text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}…` : text;
  try {
    return JSON.parse(text);
  } catch {
    return clipped;
  }
}

export function createTryHandler(d: TryDeps) {
  const doFetch = d.fetchImpl ?? fetch;
  const now = d.now ?? (() => performance.now());
  return async (req: Request, apiId: string): Promise<Response> => {
    const b = await readJson(req);
    const opId = typeof b?.opId === "string" ? b.opId : "";
    const method = typeof b?.method === "string" ? b.method.toUpperCase() : "";
    const input = b?.input;
    if (!opId || opId.length > 64 || !METHODS.has(method) || !input || typeof input !== "object" || Array.isArray(input)) {
      return errorJson(400, "Pick an endpoint and fill in its input.");
    }
    const paid = b?.paid === true;
    let token: string | undefined;
    if (paid) {
      token = d.tokens[apiId];
      if (!token) return errorJson(409, "This API has no demo credits yet, so it can only show the payment offer.");
      if (!d.allow(visitorKey(req))) return errorJson(429, "One paid try every few seconds, please. Wait a moment and try again.");
    }

    const call = buildGatewayCall(d.gatewayBase, apiId, { opId, method }, input as Record<string, unknown>, token);
    const started = now();
    let res: Response;
    try {
      res = await doFetch(call.url, { ...call.init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      return errorJson(502, "We couldn't reach the Hirakumi gateway. Try again in a minute.");
    }
    const latencyMs = Math.round(now() - started);
    const body = parseBody(await res.text());
    const remaining = res.headers.get("x-credits-remaining");
    return json({
      status: res.status,
      latencyMs,
      creditsRemaining: remaining !== null && /^\d+$/.test(remaining) ? Number(remaining) : null,
      result: describeTryResult(res.status, body),
      body,
      request: { method, url: call.url },
    });
  };
}
