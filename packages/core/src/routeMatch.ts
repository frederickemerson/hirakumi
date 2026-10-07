import { isIP } from "node:net";

/**
 * The front door's routing, pure: a request's Host to a hostname, and its method and path to one of an API's
 * operations. The reverse of buildUpstreamRequest (apps/gateway upstream.ts), which turns an input into a path.
 */

/**
 * The hostname a request was sent to, from its Host header: lowercase, without the port or a trailing dot. Null
 * when there is none, it is an IP address (v4 or [v6]), or it is not a plain DNS name. Never trust it for anything
 * but choosing a listing: it is whatever the client wrote.
 */
export function normalizeHost(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v || v.startsWith("[")) return null; // [v6] or [v6]:port
  const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(v);
  if (!m) return null; // a bare IPv6 address, or more than one colon
  const host = m[1].replace(/\.$/, "");
  if (!host || isIP(host) !== 0) return null;
  if (host.length > 253 || !/^[a-z0-9_]([a-z0-9_-]{0,62})(\.[a-z0-9_]([a-z0-9_-]{0,62}))*$/.test(host)) return null;
  // A name made only of digits and dots (1.2.3, 010.1.1.1) is read as an address by some resolvers: never a domain.
  if (/^[0-9.]+$/.test(host)) return null;
  return host;
}

/** The path after the API's path prefix ("/v1" + "/price" gives "/price"), or null when the prefix does not cover it. */
export function pathAfterPrefix(pathPrefix: string, path: string): string | null {
  const prefix = pathPrefix.replace(/\/+$/, "");
  if (prefix === "") return path.startsWith("/") ? path : null;
  if (path === prefix) return "/";
  return path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : null;
}

export type RoutableOp = { method: string; path: string };
export type RouteMatch<T extends RoutableOp> =
  | { kind: "match"; op: T; params: Record<string, string> }
  | { kind: "method_not_allowed"; allow: string[] }
  | { kind: "not_found" }
  | { kind: "bad_path"; reason: string };

type Segment = { kind: "literal"; text: string } | { kind: "param"; name: string } | { kind: "mixed"; re: RegExp; names: string[] };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function compileSegment(seg: string): Segment {
  const whole = /^\{([^{}]+)\}$/.exec(seg);
  if (whole) return { kind: "param", name: whole[1] };
  if (!seg.includes("{")) return { kind: "literal", text: seg };
  const names: string[] = [];
  let src = "";
  let last = 0;
  for (const m of seg.matchAll(/\{([^{}]+)\}/g)) {
    src += escapeRe(seg.slice(last, m.index)) + "(.+?)";
    names.push(m[1]);
    last = (m.index ?? 0) + m[0].length;
  }
  src += escapeRe(seg.slice(last));
  return { kind: "mixed", re: new RegExp(`^${src}$`), names };
}

const RANK = { literal: 2, mixed: 1, param: 0 } as const;

/**
 * One path segment as the client sent it, decoded once with buildUpstreamRequest's rules: an empty segment, "." or
 * "..", or one holding "/" or "\" after decoding is refused, so a value can never step outside the API's folder.
 */
function decodeSegment(raw: string): string | null {
  let v: string;
  try {
    v = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (v === "" || v === "." || v === ".." || /[/\\]/.test(v)) return null;
  return v;
}

/**
 * The operation a request is for. `path` is the path after the API's prefix, still percent-encoded as sent. Templates
 * like /items/{id} and /files/{name}.json match one segment per parameter; where several templates match, the one
 * with literal text earlier wins (/items/latest beats /items/{id}). A path that matches only with another method is
 * method_not_allowed, with the methods that would match.
 */
export function matchOperation<T extends RoutableOp>(ops: readonly T[], method: string, path: string): RouteMatch<T> {
  if (!path.startsWith("/")) return { kind: "bad_path", reason: "the path must start with /" };
  const rawSegments = path === "/" ? [] : path.slice(1).split("/");
  const segments: string[] = [];
  for (const raw of rawSegments) {
    const v = decodeSegment(raw);
    if (v === null) return { kind: "bad_path", reason: "the path has an empty, '.', '..' or encoded slash segment" };
    segments.push(v);
  }
  const want = method.toUpperCase();
  let best: { op: T; params: Record<string, string>; rank: number[] } | null = null;
  const allow = new Set<string>();
  for (const op of ops) {
    const tpl = op.path.replace(/\/+$/, "");
    const tplSegments = tpl === "" ? [] : tpl.replace(/^\//, "").split("/").map(compileSegment);
    if (tplSegments.length !== segments.length) continue;
    const params: Record<string, string> = {};
    const rank: number[] = [];
    let ok = true;
    for (let i = 0; i < segments.length && ok; i++) {
      const t = tplSegments[i];
      const s = segments[i];
      rank.push(RANK[t.kind]);
      if (t.kind === "literal") ok = t.text === s;
      else if (t.kind === "param") params[t.name] = s;
      else {
        const m = t.re.exec(s);
        if (!m) ok = false;
        else t.names.forEach((name, j) => { params[name] = m[j + 1]; });
      }
    }
    if (!ok) continue;
    if (op.method.toUpperCase() !== want) { allow.add(op.method.toUpperCase()); continue; }
    if (!best || compareRank(rank, best.rank) > 0) best = { op, params, rank };
  }
  if (best) return { kind: "match", op: best.op, params: best.params };
  if (allow.size) return { kind: "method_not_allowed", allow: [...allow].sort() };
  return { kind: "not_found" };
}

function compareRank(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
