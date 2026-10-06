import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent, request, type Dispatcher } from "undici";

export type UpstreamResult = { status: number; contentType: string | null; body: string; latencyMs: number };
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
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
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

type LookupCallback = (err: Error | null, address?: string | LookupAddress[], family?: number) => void;
function pinnedLookup(hostname: string, options: { all?: boolean; family?: number }, cb: LookupCallback): void {
  dnsLookup(hostname, { all: true, family: options.family ?? 0 }, (err, addrs) => {
    if (err) return cb(err);
    const bad = addrs.find((a) => isBlockedAddress(a.address));
    if (bad || addrs.length === 0) {
      return cb(new UpstreamBlockedError(`${hostname} resolves to a blocked address ${bad?.address ?? "(none)"}`));
    }
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

export async function safeFetch(
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<UpstreamResult> {
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
    return {
      status: res.statusCode,
      contentType: Array.isArray(ct) ? (ct[0] ?? null) : (ct ?? null),
      body: Buffer.concat(chunks).toString("utf8"),
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
