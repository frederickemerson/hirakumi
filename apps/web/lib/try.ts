/** "Try it live": a visitor calls a live API through the real gateway, paid with a demo credit pack. */

export type TryOperation = { opId: string; method: string };
export type TryKind = "kept" | "not_kept" | "used_up" | "pending" | "down" | "invalid_input" | "error";
export type TryResult = { kind: TryKind; headline: string; reasons: string[] };
/** What a paid call left behind: the same fields the buyer's /receipts shows. */
export type TryReceipt = {
  verdict: "kept" | "not_kept" | "no_charge";
  creditsLeft: number | null;
  /** MIP-004 output hash of a paid answer: sha256(token id + ";" + exact body). Null when no answer was paid for. */
  outputHash: string | null;
  receiptsUrl: string;
  /**
   * Escrow packs: the channel, the IOU the demo wallet signed after checking this answer (null: none), and
   * whether it disputed a "pass" that broke the promise. Null for a direct pack.
   */
  escrow?: { channelId: string; iouSigned: number | null; disputed: boolean } | null;
};

/** Gateway credit route: GET input goes in the query string, any other method sends it as the JSON body. */
export function buildGatewayCall(
  gatewayBase: string,
  apiId: string,
  op: TryOperation,
  input: Record<string, unknown>,
  token?: string,
): { url: string; init: RequestInit } {
  const method = op.method.toUpperCase();
  // Answers can be text (CSV, XML...) as well as JSON; the gateway's own answers are always JSON.
  const headers: Record<string, string> = { accept: "application/json, text/*;q=0.9, */*;q=0.8" };
  if (token) headers.authorization = `Bearer ${token}`;
  let url = `${gatewayBase.replace(/\/+$/, "")}/a/${encodeURIComponent(apiId)}/x/${encodeURIComponent(op.opId)}`;
  if (method === "GET") {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined || v === null || v === "") continue;
      qs.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    const q = qs.toString();
    if (q) url += `?${q}`;
    return { url, init: { method, headers } };
  }
  headers["content-type"] = "application/json";
  return { url, init: { method, headers, body: JSON.stringify(input) } };
}

const reasonsOf = (body: unknown): string[] => {
  const r = (body as { reasons?: unknown } | null)?.reasons;
  return Array.isArray(r) ? r.filter((x): x is string => typeof x === "string") : [];
};

const field = (body: unknown, name: string): unknown => (body as Record<string, unknown> | null)?.[name];

/** " Try again in 30 seconds." from the gateway's Retry-After seconds, or a plain "Try again in a minute." */
const tryAgain = (retryAfter: number | null | undefined) =>
  retryAfter && retryAfter > 0 ? ` Try again in ${retryAfter} second${retryAfter === 1 ? "" : "s"}.` : " Try again in a minute.";

/** `retryAfter` is the gateway's Retry-After in seconds, when it sent one. */
export function describeTryResult(status: number, body: unknown, retryAfter?: number | null): TryResult {
  const reasons = reasonsOf(body);
  const error = field(body, "error");
  if (status === 200) return { kind: "kept", headline: "Promise kept. One credit used.", reasons };
  if (status === 422 && field(body, "auth") === "refused") {
    return { kind: "not_kept", headline: "Your API refused its key on this call. No credit used.", reasons };
  }
  if (status === 422 && field(body, "auth") === "forbidden") {
    return { kind: "not_kept", headline: "Your API said its key isn't allowed to do this (HTTP 403). No credit used.", reasons };
  }
  if (status === 422) return { kind: "not_kept", headline: "Promise not kept. No credit used.", reasons };
  if (status === 503 && error === "upstream_rate_limited") {
    return { kind: "error", headline: `The API is limiting calls right now (HTTP 429). No credit used.${tryAgain(retryAfter)}`, reasons };
  }
  if (status === 429 && error === "too_many_failed_calls") {
    return { kind: "error", headline: `Too many calls on this pack failed in the last minute. No credit used.${tryAgain(retryAfter)}`, reasons };
  }
  if (status === 402) return { kind: "used_up", headline: "This pack is used up. Buy a new one live.", reasons };
  if (status === 401 && error === "token_pending") {
    return { kind: "pending", headline: "The pack payment is still settling. Try again in a few seconds.", reasons };
  }
  if (status === 503) return { kind: "down", headline: "The API is Down right now. No credit used.", reasons };
  if (status === 400) return { kind: "invalid_input", headline: "That input doesn't fit this endpoint.", reasons };
  return { kind: "error", headline: `Something went wrong (HTTP ${status}). No credit used.`, reasons };
}

/** TRY_CREDIT_TOKENS: JSON object of apiId → credit token from a pack the demo wallet bought. */
export function parseTryTokens(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""));
}

/** This API's TRY_CREDIT_TOKENS fallback token, if any. Server-side only. */
export function envTryToken(apiId: string): string | undefined {
  return parseTryTokens(process.env.TRY_CREDIT_TOKENS)[apiId];
}

/** Best-effort, per-instance limit so one visitor can't drain the demo pack. */
export function createRateLimiter(windowMs: number): (key: string, now?: number) => boolean {
  const last = new Map<string, number>();
  return (key, now = Date.now()) => {
    const prev = last.get(key);
    if (prev !== undefined && now - prev < windowMs) return false;
    // Prune expired entries only; clearing everything would let a flood reset every visitor's limit.
    if (last.size > 5000) for (const [k, t] of last) if (now - t >= windowMs) last.delete(k);
    last.set(key, now);
    return true;
  };
}

/** Masumi agent identifier = 56-hex registry policy id + hex asset name. */
export function registryLinks(agentIdentifier: string | null): { policyId: string; assetName: string; explorerUrl: string } | null {
  if (!agentIdentifier || !/^[0-9a-f]{58,120}$/i.test(agentIdentifier)) return null;
  return {
    policyId: agentIdentifier.slice(0, 56),
    assetName: agentIdentifier.slice(56),
    explorerUrl: `https://preprod.cardanoscan.io/token/${agentIdentifier}`,
  };
}

export type TryField = { name: string; required: boolean; options: string[] | null; example: string; description: string | null; json: boolean };
type InputSchema = { properties?: Record<string, Record<string, unknown>>; required?: string[] };

const show = (v: unknown): string => (v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v));

/** One form field per input property: enums become a choice, objects and arrays are typed as JSON. */
export function fieldsFromSchema(schema: InputSchema): TryField[] {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([name, p]) => {
    const options = Array.isArray(p.enum) ? p.enum.map(show) : null;
    const examples = Array.isArray(p.examples) ? p.examples : [];
    return {
      name,
      required: required.has(name),
      options,
      example: show(examples[0] ?? p.default ?? options?.[0]),
      description: typeof p.description === "string" ? p.description : null,
      json: p.type === "object" || p.type === "array",
    };
  });
}

export function coerceInput(
  fields: TryField[],
  values: Record<string, string>,
): { ok: true; input: Record<string, unknown> } | { ok: false; error: string } {
  const input: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = values[f.name] ?? "";
    if (raw === "") continue;
    if (!f.json) {
      input[f.name] = raw;
      continue;
    }
    try {
      input[f.name] = JSON.parse(raw);
    } catch {
      return { ok: false, error: `${f.name} must be valid JSON.` };
    }
  }
  return { ok: true, input };
}
