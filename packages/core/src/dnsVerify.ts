import { isIP } from "node:net";
import { verifyCodesEqual } from "./ownership";

/**
 * Ownership proof: a DNS TXT record named `_hirakumi.<host>` whose value is the API's code. Only whoever controls
 * the host's DNS can add it, so it proves the whole host, on any platform, with no change to the API itself. The
 * underscore label is a name of its own, so it works when the host is a CNAME (Vercel, Netlify, a CDN), the same way
 * ACME's _acme-challenge does.
 */
export const DNS_VERIFY_LABEL = "_hirakumi";

export type VerifyRecord = { ok: true; host: string; name: string } | { ok: false; host: string; detail: string };

/** The record that proves `origin`: `_hirakumi.` + its hostname, lowercase. Refused for hosts with no DNS of their own. */
export function verifyRecordFor(origin: string): VerifyRecord {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return { ok: false, host: origin, detail: "The API's address is not a valid URL." };
  }
  if (isIP(host) !== 0 || host.startsWith("[")) {
    return { ok: false, host, detail: "The API's address is an IP address, which has no DNS to add a record to. Give it a domain name." };
  }
  if (!host.includes(".")) {
    return { ok: false, host, detail: "The API's address has no domain (like api.example.com), so there is no DNS to add a record to." };
  }
  return { ok: true, host, name: `${DNS_VERIFY_LABEL}.${host}` };
}

export type TxtMatch = "match" | "missing" | "mismatch";

/** One TXT value: its strings joined (long values come split in 255-byte chunks), trimmed, one pair of quotes removed. */
function txtValue(chunks: readonly string[]): string {
  const v = chunks.join("").trim();
  return v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1).trim() : v;
}

/**
 * Compares the TXT records at `_hirakumi.<host>` with this API's code. A host can carry several (one per API on it),
 * so it matches when any one equals the code exactly. Records there but none with this code is "mismatch".
 */
export function matchVerifyTxt(records: readonly (readonly string[])[], expectedCode: string): TxtMatch {
  if (records.length === 0) return "missing";
  let found = false;
  for (const r of records) found = verifyCodesEqual(expectedCode, txtValue(r)) || found; // no early exit
  return found ? "match" : "mismatch";
}

/** Resolves TXT records: node:dns resolveTxt's shape. Throws an error with a `code` (ENODATA, ENOTFOUND, …) on failure. */
export type TxtLookup = (name: string) => Promise<string[][]>;

/** The name has no TXT records, or does not exist: the record is not there. Anything else is a failed lookup. */
export function isNoRecordError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "ENODATA" || code === "ENOTFOUND" || code === "NXDOMAIN";
}

/** A passing DNS check of the ownership record counts for this long (the ownership page, the coworker, /act). */
export const VERIFY_PASS_TTL_MINUTES = 30;
