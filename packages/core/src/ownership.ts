import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Ownership proof, part 1: the seller's API sends this response header with the API's code. The gateway reads it
 * from one plain GET to the API's base URL (origin + path_prefix), on any status. Only someone who controls the
 * responses under that base can add it, so it proves the folder of the base URL.
 */
export const VERIFY_HEADER = "X-Hirakumi-Verify";

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

export type HeaderMatch = "match" | "missing" | "mismatch";

/**
 * Compares the X-Hirakumi-Verify header with this API's code. The header may be repeated (an array) or
 * comma-joined; it matches when any one value, trimmed, equals the code exactly. Present but wrong is "mismatch".
 */
export function matchVerifyHeader(value: string | readonly string[] | null | undefined, expectedCode: string): HeaderMatch {
  if (value === null || value === undefined) return "missing";
  const values = (typeof value === "string" ? [value] : value).flatMap((v) => v.split(",")).map((v) => v.trim());
  let found = false;
  for (const v of values) found = verifyCodesEqual(expectedCode, v) || found; // compare every value, no early exit
  return found ? "match" : "mismatch";
}

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

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

/** A server may decode these and walk to another directory, so a path that has them proves nothing. */
export const AMBIGUOUS_PATH = /%2f|%5c|%2e|;/i;

/**
 * Why an endpoint path could step outside the folder its base path was proven for, or null when it is plain.
 * URLs collapse "." and ".." segments (also when written %2e, any case), and some servers also treat "\",
 * ";" or an encoded "/" or "\" as separators. Appended to a proven base path, any of these could reach
 * another tenant's folder on the same host.
 */
export function unsafePathReason(path: string): string | null {
  if (path.includes("\\")) return "its path has a backslash";
  if (/%2f|%5c/i.test(path)) return "its path has an encoded slash";
  if (path.includes(";")) return "its path has a ';'";
  if (path.split("/").some((seg) => /^\.{1,2}$/.test(seg.replace(/%2e/gi, ".")))) return "its path has a dot segment (. or ..)";
  return null;
}

/** True when a built upstream URL is on the API's origin and at or under its proven base path. */
export function urlWithinBase(url: URL, origin: string, pathPrefix: string): boolean {
  let base: URL;
  try {
    base = new URL(pathPrefix || "/", origin);
  } catch {
    return false;
  }
  if (url.origin !== base.origin) return false;
  const prefix = base.pathname.replace(/\/+$/, "");
  return prefix === "" || url.pathname === prefix || url.pathname.startsWith(`${prefix}/`);
}

export type CheckUrl = { ok: true; url: string } | { ok: false; url: string; detail: string };

// Shortest run of the code's characters that counts as the code appearing in a URL.
const CODE_RUN = 10;

/** Fully percent-decoded (a few rounds, for double encoding) and lowercased. */
function decodedLower(s: string): string {
  let out = s;
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(out);
      if (next === out) break;
      out = next;
    } catch {
      break;
    }
  }
  return out.toLowerCase();
}

/**
 * True when the code, or any run of CODE_RUN of its characters, appears in the URL: as written, percent-decoded,
 * any case, or with separators put between its characters. A reflection service (an endpoint that echoes a
 * header named in its URL back in its answer) could otherwise prove a code the seller never controlled.
 */
export function urlCarriesCode(url: string, code: string): boolean {
  const alnum = (s: string) => s.replace(/[^a-z0-9]/g, "");
  const secret = alnum(code.toLowerCase().replace(/^hkv_/, ""));
  if (secret.length < CODE_RUN) return decodedLower(url).includes(code.toLowerCase()); // never a real code
  const hay = [url.toLowerCase(), decodedLower(url)];
  hay.push(alnum(hay[1]));
  for (let i = 0; i + CODE_RUN <= secret.length; i++) {
    const run = secret.slice(i, i + CODE_RUN);
    if (hay.some((h) => h.includes(run))) return true;
  }
  return false;
}

/** The API's base URL as written: origin + path_prefix ("/" or "" means the origin's root). Shown to sellers. */
export function apiBaseUrl(a: { origin: string; pathPrefix: string }): string {
  return `${a.origin.replace(/\/+$/, "")}${a.pathPrefix === "" ? "/" : a.pathPrefix}`;
}

/**
 * The one URL the ownership check requests: the API's base URL (apiBaseUrl), with no query or fragment. Refused
 * when the base is not a plain path within itself, or when the URL carries the code.
 */
export function ownershipCheckUrl(a: { origin: string; pathPrefix: string; code: string }): CheckUrl {
  const prefix = a.pathPrefix === "" ? "/" : a.pathPrefix;
  const written = apiBaseUrl(a);
  const fail = (detail: string, url = written): CheckUrl => ({ ok: false, url, detail });
  let origin: URL;
  try {
    origin = new URL(a.origin);
  } catch {
    return fail("The API's address is not a valid URL.");
  }
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" || /[?#]/.test(a.origin)) {
    return fail("The API's address must be a plain origin, like https://api.example.com.");
  }
  if (!prefix.startsWith("/") || /[?#]/.test(prefix)) return fail("The API's base path must be a plain path starting with /.");
  if (AMBIGUOUS_PATH.test(prefix) || prefix.includes("//") || unsafePathReason(prefix)) {
    return fail("The API's base path has an encoded slash, dot, a ';' or a backslash. Use a plain path.");
  }
  let url: URL;
  try {
    url = new URL(`${origin.origin}${prefix}`);
  } catch {
    return fail("The API's base URL is not a valid URL.");
  }
  const href = url.href;
  if (url.search !== "" || url.hash !== "" || !urlWithinBase(url, origin.origin, prefix) || AMBIGUOUS_PATH.test(url.pathname)) {
    return fail("The API's base URL is not a plain path.", href);
  }
  if (urlCarriesCode(href, a.code)) {
    return fail("The API's base URL contains the verification code. Hirakumi can't check a URL that carries the code.", href);
  }
  return { ok: true, url: href };
}
