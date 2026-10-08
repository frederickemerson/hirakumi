import { Resolver } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent, request } from "undici";
import { isNoRecordError, normalizeHost } from "@hirakumi/core";
import { getDomainRoute, SERVED_DOMAIN_STATUSES, tlsAllowed, type DomainRoute, type Sql } from "@hirakumi/db";

const DOMAIN_TTL_MS = 60_000;

/**
 * The front-door hosts, cached for DOMAIN_TTL_MS, unknown hosts too (a scan of random names must not reach the
 * database on every request). /internal/domains/:host/reload forgets one at once.
 */
export class DomainRegistry {
  private readonly cache = new Map<string, { at: number; value: Promise<DomainRoute | null> }>();
  constructor(private readonly sql: Sql, private readonly ttlMs = DOMAIN_TTL_MS) {}

  get(host: string): Promise<DomainRoute | null> {
    const hit = this.cache.get(host);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const value = getDomainRoute(this.sql, host);
    this.cache.set(host, { at: Date.now(), value });
    value.catch(() => { this.cache.delete(host); });
    // Bounded: a flood of names can't grow it without end. Oldest first out.
    if (this.cache.size > 10_000) this.cache.delete(this.cache.keys().next().value as string);
    return value;
  }

  invalidate(host: string): void {
    this.cache.delete(host);
  }
}

export const isServed = (route: DomainRoute | null): route is DomainRoute => !!route && SERVED_DOMAIN_STATUSES.includes(route.status);

/** Caddy's on-demand TLS ask: may Caddy get a certificate for this name? From the database only, no live DNS. */
export async function tlsAskDecision(domains: DomainRegistry, raw: string | undefined): Promise<boolean> {
  const host = normalizeHost(raw);
  if (!host || !host.includes(".")) return false;
  return tlsAllowed(await domains.get(host));
}

/** A, AAAA and CNAME lookups: node:dns/promises Resolver's shape. Tests pass a fake. */
export type AddressResolver = {
  resolve4(name: string): Promise<string[]>;
  resolve6(name: string): Promise<string[]>;
  resolveCname(name: string): Promise<string[]>;
};

export function addressResolverVia(servers: readonly string[]): AddressResolver {
  const r = new Resolver({ timeout: 3_000, tries: 2 });
  if (servers.length) r.setServers([...servers]);
  return { resolve4: (n) => r.resolve4(n), resolve6: (n) => r.resolve6(n), resolveCname: (n) => r.resolveCname(n) };
}

export type RoutedCheck = {
  outcome: "routed" | "not_routed" | "error";
  /** The CNAME chain followed from the host, then the addresses found at its end. */
  chain: string[]; addresses: string[]; detail: string;
};

const MAX_CNAME_HOPS = 8;

/**
 * Does `host` resolve only to Hirakumi (EDGE_IPS)? Follows the CNAME chain, then every A and AAAA record must be one
 * of ours: one foreign address (an old AAAA record, say) would send some callers straight to the seller's server.
 * A DNS server that does not answer is an error, which never counts for or against the host.
 */
export async function checkRouted(resolver: AddressResolver, host: string, edgeIps: readonly string[]): Promise<RoutedCheck> {
  const edges = new BlockList();
  for (const ip of edgeIps) edges.addAddress(ip, isIP(ip) === 6 ? "ipv6" : "ipv4");
  const ours = (ip: string) => isIP(ip) !== 0 && edges.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4");
  const chain: string[] = [];
  const records = async (fn: () => Promise<string[]>): Promise<string[] | Error> => {
    try {
      return await fn();
    } catch (e) {
      return isNoRecordError(e) ? [] : (e as Error);
    }
  };
  let name = host;
  for (let i = 0; i <= MAX_CNAME_HOPS; i++) {
    const cname = await records(() => resolver.resolveCname(name));
    if (cname instanceof Error) return { outcome: "error", chain, addresses: [], detail: `DNS did not answer for ${name} (${codeOf(cname)}).` };
    if (cname.length === 0) break;
    if (i === MAX_CNAME_HOPS) return { outcome: "not_routed", chain, addresses: [], detail: `${host} has a CNAME chain longer than ${MAX_CNAME_HOPS}.` };
    name = cname[0].toLowerCase().replace(/\.$/, "");
    chain.push(name);
  }
  const [v4, v6] = await Promise.all([records(() => resolver.resolve4(name)), records(() => resolver.resolve6(name))]);
  if (v4 instanceof Error || v6 instanceof Error) {
    return { outcome: "error", chain, addresses: [], detail: `DNS did not answer for ${name} (${codeOf((v4 instanceof Error ? v4 : v6) as Error)}).` };
  }
  const addresses = [...v4, ...v6];
  if (addresses.length === 0) return { outcome: "not_routed", chain, addresses, detail: `${host} has no A or AAAA record yet.` };
  const foreign = addresses.filter((a) => !ours(a));
  if (foreign.length) {
    const what = foreign.map((a) => `${a} (${isIP(a) === 6 ? "AAAA" : "A"})`).join(", ");
    return { outcome: "not_routed", chain, addresses, detail: `${host} still points at ${what}, which is not Hirakumi.` };
  }
  return { outcome: "routed", chain, addresses, detail: `${host} points at Hirakumi.` };
}

const codeOf = (e: Error) => (e as { code?: string }).code ?? e.message;

/** One HTTPS request to the front door through its public name: status and the API the answer came from. */
export type FrontDoorProbe = (host: string, path: string) => Promise<{ status: number; apiId: string | null }>;

/**
 * The live probe: GET https://<host><path> sent to our own edge address (the routed check just showed the host
 * resolves only there), with the TLS name of the host, so Caddy's certificate for it is what is checked.
 */
export function frontDoorProbeVia(edgeIp: string, timeoutMs = 10_000): FrontDoorProbe {
  const agent = new Agent({
    connect: {
      lookup: ((_h: string, opts: { all?: boolean }, cb: (e: Error | null, a: unknown, f?: number) => void) => {
        const family = isIP(edgeIp);
        if (opts?.all) cb(null, [{ address: edgeIp, family }]);
        else cb(null, edgeIp, family);
      }) as never,
    },
  });
  return async (host, path) => {
    const res = await request(`https://${host}${path}`, {
      method: "GET", dispatcher: agent, signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json", "user-agent": "hirakumi-gateway/0.1" },
    });
    res.body.on("error", () => undefined);
    res.body.destroy();
    const api = res.headers["x-hirakumi-api"];
    return { status: res.statusCode, apiId: (Array.isArray(api) ? api[0] : api) ?? null };
  };
}
