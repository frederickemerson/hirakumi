import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import YAML from "yaml";

/**
 * Ownership proof, part 1: the seller puts a per-API code at the root of the OpenAPI file Hirakumi reads.
 * Writing to that file proves control of the directory it is served from, so the API's base path must lie
 * at or under that directory, on the same origin (see checkSpecBinding).
 */
export const VERIFY_FIELD = "x-hirakumi-verify";

/** 32 random bytes (256 bits), base64url, with a recognisable prefix. One per API, never reused. */
export function newVerifyCode(): string {
  return `hkv_${randomBytes(32).toString("base64url")}`;
}

/** Exact, constant-time comparison (hashing first makes the lengths equal). */
export function verifyCodesEqual(expected: string, given: string): boolean {
  const a = createHash("sha256").update(expected, "utf8").digest();
  const b = createHash("sha256").update(given, "utf8").digest();
  return timingSafeEqual(a, b) && expected.length === given.length;
}

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Parses an OpenAPI document as JSON, else YAML. Null when it is neither or its root is not an object. */
export function readSpec(text: string): Json | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    try {
      raw = YAML.parse(text, { maxAliasCount: 100 });
    } catch {
      return null;
    }
  }
  return isRecord(raw) ? raw : null;
}

export type SpecFieldResult = { kind: "match" } | { kind: "missing" } | { kind: "mismatch" } | { kind: "unreadable" };

/** Reads `x-hirakumi-verify` at the document root only and compares it exactly with this API's code. */
export function verifySpecField(text: string, expectedCode: string): SpecFieldResult {
  const doc = readSpec(text);
  return doc ? verifyDocField(doc, expectedCode) : { kind: "unreadable" };
}

/** Same as verifySpecField, for a document already parsed with readSpec. */
export function verifyDocField(doc: Record<string, unknown>, expectedCode: string): Exclude<SpecFieldResult, { kind: "unreadable" }> {
  if (!Object.hasOwn(doc, VERIFY_FIELD)) return { kind: "missing" };
  const value = doc[VERIFY_FIELD];
  if (typeof value !== "string") return { kind: "mismatch" };
  return verifyCodesEqual(expectedCode, value.trim()) ? { kind: "match" } : { kind: "mismatch" };
}

/** servers[0].url with {variables} replaced by their defaults (OpenAPI 3 server object), or null when absent. */
export function firstServerUrl(servers: unknown): string | null {
  const first = Array.isArray(servers) ? servers[0] : undefined;
  if (!isRecord(first) || typeof first.url !== "string" || !first.url.trim()) return null;
  const vars = isRecord(first.variables) ? first.variables : {};
  return first.url.trim().replace(/\{([^}]+)\}/g, (whole, name: string) => {
    const v = vars[name];
    return isRecord(v) && typeof v.default === "string" ? v.default : whole;
  });
}

/** The directory a spec URL is served from: its path up to and including the last "/". */
export function specDirectory(specUrl: URL): string {
  return specUrl.pathname.slice(0, specUrl.pathname.lastIndexOf("/") + 1);
}

export type BindingResult =
  | { ok: true }
  | { ok: false; reason: "bad_url" | "origin_mismatch" | "outside_directory"; detail: string };

// A server may decode these and walk to another directory, so a path that has them proves nothing.
const AMBIGUOUS_PATH = /%2f|%5c|%2e|;/i;

const asDir = (path: string) => (path.endsWith("/") ? path : `${path}/`);

/**
 * The security binding between the spec the seller edited and the API Hirakumi will sell:
 * 1. the spec is served from the API's origin (scheme, host and port);
 * 2. the API's base path (path_prefix, and the spec's current servers[0] when given) lies at or under
 *    the spec's directory. On a shared host, controlling one path only proves control of that subtree.
 */
export function checkSpecBinding(a: { openapiUrl: string; origin: string; pathPrefix: string; serverUrl?: string | null }): BindingResult {
  let spec: URL, origin: URL;
  try {
    spec = new URL(a.openapiUrl);
    origin = new URL(a.origin);
  } catch {
    return { ok: false, reason: "bad_url", detail: "The OpenAPI link is not a valid URL." };
  }
  if (spec.origin !== origin.origin) {
    return { ok: false, reason: "origin_mismatch", detail: `The OpenAPI file is on ${spec.origin}, but the API runs on ${origin.origin}. They must be the same.` };
  }
  if (AMBIGUOUS_PATH.test(spec.pathname)) {
    return { ok: false, reason: "bad_url", detail: "The OpenAPI link has an encoded slash, dot or a ';' in its path. Use a plain path." };
  }
  const dir = specDirectory(spec);
  const bases: string[] = [a.pathPrefix];
  if (a.serverUrl) {
    let server: URL;
    try {
      server = new URL(a.serverUrl, spec);
    } catch {
      return { ok: false, reason: "bad_url", detail: `servers[0] in your OpenAPI file is not a valid URL: ${a.serverUrl}` };
    }
    if (server.origin !== origin.origin) {
      return { ok: false, reason: "origin_mismatch", detail: `servers[0] in your OpenAPI file points to ${server.origin}, but the API runs on ${origin.origin}. They must be the same.` };
    }
    bases.push(server.pathname);
  }
  for (const base of bases) {
    if (AMBIGUOUS_PATH.test(base)) {
      return { ok: false, reason: "bad_url", detail: "The API's base path has an encoded slash, dot or a ';'. Use a plain path." };
    }
    if (!asDir(base).startsWith(dir)) {
      return {
        ok: false,
        reason: "outside_directory",
        detail: `The OpenAPI file is in ${dir}, so it can only prove ownership of APIs under ${dir}. The API's base path is ${base}. Serve the file from ${base === "/" ? "/" : asDir(base)} or a parent folder of it.`,
      };
    }
  }
  return { ok: true };
}
