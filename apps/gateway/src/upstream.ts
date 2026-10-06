import { safeFetch, urlWithinBase, UpstreamBlockedError, UpstreamTimeoutError, UpstreamTooLargeError, type UpstreamResult } from "@hirakumi/core";
import type { ApiRow, OperationRow } from "@hirakumi/db";
import type { LoadedOp } from "./registry";

export function buildUpstreamRequest(
  api: Pick<ApiRow, "origin" | "path_prefix">,
  op: Pick<OperationRow, "method" | "path">,
  input: Record<string, unknown>,
): { url: string; init: { method: string; headers: Record<string, string>; body?: string } } {
  const rest: Record<string, unknown> = { ...input };
  const path = op.path.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const v = rest[name];
    if (v === undefined || v === null) throw new Error(`missing path parameter ${name}`);
    // "." / ".." (also percent-encoded) or "" would let a buyer step outside the path prefix whose ownership
    // was verified, because URLs normalise dot segments.
    const raw = String(v);
    let decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch { /* keep raw */ }
    if (raw === "" || /^\.{1,2}$/.test(raw) || /^\.{1,2}$/.test(decoded)) throw new Error(`invalid path parameter ${name}`);
    delete rest[name];
    return encodeURIComponent(String(v));
  });
  const prefix = api.path_prefix.replace(/\/+$/, "");
  const url = new URL(api.origin.replace(/\/+$/, "") + prefix + path);
  // Defence in depth (audit C1): URL parsing collapses dot segments and can even move the host, so check the
  // result, not the parts. Every upstream call (paid calls, escrow jobs, previews, QA, monitor) is built here.
  if (!urlWithinBase(url, api.origin, api.path_prefix)) {
    throw new Error(`blocked: the endpoint path ${op.path} resolves outside the API's folder (${prefix || "/"}) on ${new URL(api.origin).origin}`);
  }
  const method = op.method.toUpperCase();
  const headers: Record<string, string> = { accept: "application/json", "user-agent": "hirakumi-gateway/0.1" };
  // Shared input convention (P3 contract addition 3): `{name}` fields fill the path, a field named
  // `body` is the JSON request body, and every other field is a query parameter, for any method.
  const { body, ...query } = rest;
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const x of v) url.searchParams.append(k, String(x));
    else url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  if (body === undefined || method === "GET" || method === "HEAD") return { url: url.toString(), init: { method, headers } };
  headers["content-type"] = "application/json";
  return { url: url.toString(), init: { method, headers, body: JSON.stringify(body) } };
}

/** MIP-003 input_data arrives as an object (Sokosumi) or as [{key, value}] (MIP-003 examples). */
export function normalizeMip003Input(inputData: unknown): Record<string, unknown> | null {
  if (Array.isArray(inputData)) {
    const out: Record<string, unknown> = {};
    for (const item of inputData) {
      if (!item || typeof item !== "object" || typeof (item as { key?: unknown }).key !== "string") return null;
      out[(item as { key: string }).key] = (item as { value?: unknown }).value;
    }
    return out;
  }
  if (inputData && typeof inputData === "object") return { ...(inputData as Record<string, unknown>) };
  return null;
}

export type Execution = "upstream_ok" | "upstream_error" | "timeout" | "blocked";
export type OperationOutcome = {
  execution: Execution; verdict: "pass" | "fail" | "n/a"; reasons: string[]; result: UpstreamResult | null; latencyMs: number;
};

export async function runOperation(
  api: Pick<ApiRow, "origin" | "path_prefix">,
  op: LoadedOp,
  input: Record<string, unknown>,
  opts: { timeoutMs: number; probe?: boolean },
): Promise<OperationOutcome> {
  const failVerdict = op.rule ? "fail" : "n/a";
  let req: ReturnType<typeof buildUpstreamRequest>;
  try {
    req = buildUpstreamRequest(api, op.row, input);
  } catch (e) {
    return { execution: "blocked", verdict: "n/a", reasons: [(e as Error).message], result: null, latencyMs: 0 };
  }
  if (opts.probe) req.init.headers["x-hirakumi-probe"] = "1";
  const started = performance.now();
  try {
    const result = await safeFetch(req.url, req.init, { timeoutMs: opts.timeoutMs });
    if (result.status >= 500) {
      return { execution: "upstream_error", verdict: failVerdict, reasons: [`upstream answered ${result.status}`], result, latencyMs: result.latencyMs };
    }
    if (!op.rule) return { execution: "upstream_ok", verdict: "n/a", reasons: [], result, latencyMs: result.latencyMs };
    const v = op.rule.check(result);
    return { execution: "upstream_ok", verdict: v.pass ? "pass" : "fail", reasons: v.reasons, result, latencyMs: result.latencyMs };
  } catch (e) {
    const latencyMs = Math.round(performance.now() - started);
    if (e instanceof UpstreamBlockedError) return { execution: "blocked", verdict: "n/a", reasons: [e.message], result: null, latencyMs };
    if (e instanceof UpstreamTimeoutError) return { execution: "timeout", verdict: failVerdict, reasons: [e.message], result: null, latencyMs };
    if (e instanceof UpstreamTooLargeError) return { execution: "upstream_error", verdict: failVerdict, reasons: [e.message], result: null, latencyMs };
    return { execution: "upstream_error", verdict: failVerdict, reasons: [(e as Error).message], result: null, latencyMs };
  }
}
