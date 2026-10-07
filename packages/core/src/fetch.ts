import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent, request, type Dispatcher } from "undici";
import { isJsonMediaType, mediaTypeOf } from "./rules";

export type UpstreamResult = { status: number; contentType: string | null; body: string; latencyMs: number };
/** Response headers as undici gives them: lowercase names, a repeated header as an array. */
export type UpstreamHeaders = Record<string, string | string[] | undefined>;
/** A header probe's answer: the status and headers only. The body is never read. */
export type UpstreamProbe = { status: number; headers: UpstreamHeaders; latencyMs: number };
export class UpstreamBlockedError extends Error { override name = "UpstreamBlockedError"; }
/** A 3xx answer. Never followed: a redirect would let a URL vouch for content served somewhere else. */
export class UpstreamRedirectError extends UpstreamBlockedError {
  override name = "UpstreamRedirectError";
  constructor(readonly status: number, readonly location: string | null) {
    super(`redirects are not followed (status ${status})`);
  }
}
export class UpstreamTimeoutError extends Error { override name = "UpstreamTimeoutError"; }
export class UpstreamTooLargeError extends Error { override name = "UpstreamTooLargeError"; }

export const UPSTREAM_TIMEOUT_MS = 15_000;
export const MAX_REQUEST_BYTES = 262_144;
export const MAX_RESPONSE_BYTES = 1_048_576;

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["2001:db8::", 32], ["2002::", 16],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
  ["fec0::", 10], // deprecated site-local
  ["100::", 64], // discard-only
  ["2001::", 32], // Teredo: tunnels to an embedded IPv4 address
] as const) blocked.addSubnet(net, prefix, "ipv6");

function hexToIPv4(hiHex: string, loHex: string): string {
  const hi = parseInt(hiHex, 16), lo = parseInt(loHex, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** True for private, loopback, link-local (incl. 169.254.169.254 metadata), CGNAT, multicast, reserved, or non-IP input. */
export function isBlockedAddress(addr: string): boolean {
  // IPv4-mapped IPv6 (::ffff:a.b.c.d or ::ffff:hhhh:hhhh) and SIIT IPv4-translated IPv6
  // (::ffff:0:a.b.c.d or ::ffff:0:hhhh:hhhh) are judged by their embedded IPv4 address.
  // (Node's BlockList can't hold ::ffff:0:0/96: it then matches every plain IPv4 address.)
  const mapped = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  if (mapped) return isBlockedAddress(mapped[1]);
  const mappedHex = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(addr);
  if (mappedHex) return isBlockedAddress(hexToIPv4(mappedHex[1], mappedHex[2]));
  const siit = /^(?:0{0,4}:){0,4}:?ffff:0{1,4}:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  if (siit) return isBlockedAddress(siit[1]);
  const siitHex = /^(?:0{0,4}:){0,4}:?ffff:0{1,4}:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(addr);
  if (siitHex) return isBlockedAddress(hexToIPv4(siitHex[1], siitHex[2]));
  // Deprecated IPv4-compatible IPv6 (::a.b.c.d / ::hhhh:hhhh) is never a public destination.
  if (/^::(?:(?:[0-9a-f]{1,4}:)?[0-9a-f]{1,4}|\d{1,3}(?:\.\d{1,3}){3})$/i.test(addr) && addr !== "::1") return true;
  const family = isIP(addr);
  if (family === 0) return true;
  return blocked.check(addr, family === 6 ? "ipv6" : "ipv4");
}

let selfList = new BlockList();
let selfCount = 0;

/**
 * Hirakumi's own public addresses (the gateway's EDGE_IPS). An upstream that resolves to one would loop through the
 * front door back into the gateway, so it is refused like a private address. Set once at start; empty by default.
 */
export function setSelfAddresses(ips: readonly string[]): void {
  const list = new BlockList();
  for (const ip of ips) {
    const family = isIP(ip);
    if (family === 0) throw new Error(`not an IP address: ${ip}`);
    list.addAddress(ip, family === 6 ? "ipv6" : "ipv4");
  }
  selfList = list;
  selfCount = ips.length;
}

/** True when addr is one of Hirakumi's own addresses (setSelfAddresses), also written as IPv4-mapped IPv6. */
export function isSelfAddress(addr: string): boolean {
  if (selfCount === 0) return false;
  const mapped = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  if (mapped) return isSelfAddress(mapped[1]);
  const mappedHex = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(addr);
  if (mappedHex) return isSelfAddress(hexToIPv4(mappedHex[1], mappedHex[2]));
  const family = isIP(addr);
  return family !== 0 && selfList.check(addr, family === 6 ? "ipv6" : "ipv4");
}

/** Why these resolved addresses of `hostname` may not be called, or null when all are fine. */
export function resolvedAddressProblem(hostname: string, addrs: readonly { address: string }[]): string | null {
  if (addrs.length === 0) return `${hostname} resolves to a blocked address (none)`;
  const self = addrs.find((a) => isSelfAddress(a.address));
  if (self) return `${hostname} resolves to Hirakumi's own address ${self.address}, which would loop back through Hirakumi`;
  const bad = addrs.find((a) => isBlockedAddress(a.address));
  return bad ? `${hostname} resolves to a blocked address ${bad.address}` : null;
}

type LookupCallback = (err: Error | null, address?: string | LookupAddress[], family?: number) => void;
function pinnedLookup(hostname: string, options: { all?: boolean; family?: number }, cb: LookupCallback): void {
  dnsLookup(hostname, { all: true, family: options.family ?? 0 }, (err, addrs) => {
    if (err) return cb(err);
    const problem = resolvedAddressProblem(hostname, addrs);
    if (problem) return cb(new UpstreamBlockedError(problem));
    if (options.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

const strictAgent = new Agent({ connect: { lookup: pinnedLookup as unknown as LookupFunction }, keepAliveTimeout: 10_000 });
const localAgent = new Agent({ keepAliveTimeout: 10_000 });

/** Drop a response body we refuse. The listener matters: destroy() makes undici emit an
 *  AbortError on the stream, and an unhandled stream error would crash the process. */
function discard(body: NodeJS.ReadableStream & { destroy(): void }): void {
  body.on("error", () => undefined);
  body.destroy();
}

/** The charset parameter of a Content-Type header, lowercased, or null. */
function charsetOf(contentType: string | null): string | null {
  const m = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType ?? "");
  return m ? m[1].toLowerCase() : null;
}

/**
 * The body as text. A byte order mark wins (UTF-8, UTF-16LE or UTF-16BE), then the declared charset when
 * TextDecoder knows it (utf-16le/be, iso-8859-1/latin1, windows-1252, …), else UTF-8. JSON is always UTF-8 (RFC 8259
 * gives its charset parameter no meaning, and a wrong label must not change answers that pass today).
 * A leading BOM is never part of the text: buyers read answers with WHATWG res.text(), which drops it, so rule
 * checks, output hashes, stored outputs and what the gateway passes on (always as UTF-8) all see the buyer's string.
 */
export function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  let encoding = "utf-8";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
  else if (!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) {
    const declared = isJsonMediaType(mediaTypeOf(contentType)) ? null : charsetOf(contentType);
    if (declared) {
      try {
        encoding = new TextDecoder(declared).encoding;
      } catch { /* unknown charset: keep UTF-8 */ }
    }
  }
  // TextDecoder drops the BOM it decodes. Any U+FEFF still at the start goes too: the gateway passes answers on as
  // UTF-8, so a body starting with U+FEFF would reach the buyer as a BOM, which res.text() drops again.
  return new TextDecoder(encoding).decode(bytes).replace(/^\uFEFF+/, "");
}

export async function safeFetch(
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<UpstreamResult> {
  return (await fetchGuarded(url, init, opts, false)) as UpstreamResult;
}

/**
 * safeFetch that answers with the status and response headers as soon as they arrive, and drops the body
 * unread, so a large or streaming body cannot hide a header that is there. A 3xx is an answer like any other
 * and is never followed. Same SSRF rules and timeout (to the headers) as safeFetch.
 */
export async function safeFetchWithHeaders(
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
  opts: { timeoutMs?: number } = {},
): Promise<UpstreamProbe> {
  return (await fetchGuarded(url, init, opts, true)) as UpstreamProbe;
}

async function fetchGuarded(
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
  opts: { timeoutMs?: number; maxBytes?: number },
  headersOnly: boolean,
): Promise<UpstreamResult | UpstreamProbe> {
  const timeoutMs = opts.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_RESPONSE_BYTES;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new UpstreamBlockedError(`not a valid URL: ${url}`);
  }
  const insecureOk =
    process.env.ALLOW_INSECURE_UPSTREAM === "1" &&
    u.protocol === "http:" &&
    (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  if (u.protocol !== "https:" && !insecureOk) {
    throw new UpstreamBlockedError(`only https upstreams are allowed (got ${u.protocol}//${u.host})`);
  }
  if (u.username || u.password) throw new UpstreamBlockedError("credentials in the URL are not allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!insecureOk && isIP(host) !== 0 && isBlockedAddress(host)) throw new UpstreamBlockedError(`blocked address ${host}`);
  // Checked in local test mode too, so tests can stand in a local address for Hirakumi's own.
  if (isIP(host) !== 0 && isSelfAddress(host)) throw new UpstreamBlockedError(`${host} is Hirakumi's own address, which would loop back through Hirakumi`);
  if (init.body !== undefined && Buffer.byteLength(init.body) > MAX_REQUEST_BYTES) {
    throw new UpstreamTooLargeError("request body is over 256 KB");
  }

  const signal = AbortSignal.timeout(timeoutMs);
  const started = performance.now();
  try {
    const res = await request(u, {
      method: init.method.toUpperCase() as Dispatcher.HttpMethod,
      headers: init.headers,
      body: init.body,
      dispatcher: insecureOk ? localAgent : strictAgent,
      signal,
    });
    if (headersOnly) {
      discard(res.body);
      return { status: res.statusCode, headers: { ...res.headers }, latencyMs: Math.round(performance.now() - started) };
    }
    if (res.statusCode >= 300 && res.statusCode < 400) {
      discard(res.body);
      const loc = res.headers.location;
      throw new UpstreamRedirectError(res.statusCode, (Array.isArray(loc) ? loc[0] : loc) ?? null);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += (chunk as Buffer).length;
      if (size > maxBytes) {
        discard(res.body);
        throw new UpstreamTooLargeError(`response is over ${maxBytes} bytes`);
      }
      chunks.push(chunk as Buffer);
    }
    const ct = res.headers["content-type"];
    const contentType = Array.isArray(ct) ? (ct[0] ?? null) : (ct ?? null);
    return {
      status: res.statusCode,
      contentType,
      body: decodeBody(Buffer.concat(chunks), contentType),
      latencyMs: Math.round(performance.now() - started),
    };
  } catch (err) {
    if (err instanceof UpstreamBlockedError || err instanceof UpstreamTooLargeError) throw err;
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof UpstreamBlockedError) throw cause;
    if (signal.aborted) throw new UpstreamTimeoutError(`upstream did not answer within ${timeoutMs} ms`);
    throw err;
  }
}
