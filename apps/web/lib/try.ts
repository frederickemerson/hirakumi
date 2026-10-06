/** "Try it live": a visitor calls a live API through the real gateway, paid with a demo credit pack. */

export type TryOperation = { opId: string; method: string };
export type TryKind = "kept" | "not_kept" | "payment_required" | "down" | "invalid_input" | "error";
export type TryResult = { kind: TryKind; headline: string; reasons: string[] };

/** Gateway credit route: GET input goes in the query string, any other method sends it as the JSON body. */
export function buildGatewayCall(
  gatewayBase: string,
  apiId: string,
  op: TryOperation,
  input: Record<string, unknown>,
  token?: string,
): { url: string; init: RequestInit } {
  const method = op.method.toUpperCase();
  const headers: Record<string, string> = { accept: "application/json" };
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

export function describeTryResult(status: number, body: unknown): TryResult {
  const reasons = reasonsOf(body);
  if (status === 200) return { kind: "kept", headline: "Promise kept. One credit used.", reasons };
  if (status === 422) return { kind: "not_kept", headline: "Promise not kept. No credit used.", reasons };
  if (status === 402) return { kind: "payment_required", headline: "Payment required. This is the offer a buying agent sees.", reasons };
  if (status === 503) return { kind: "down", headline: "The API is Down right now, so nobody is charged.", reasons };
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
