import { parse } from "tldts";
import { providerFromNameservers, type DnsSetup } from "@/lib/dns-provider";

/** Google's DNS-over-HTTPS JSON API: works from any host over HTTPS, no UDP needed. */
const DOH = "https://dns.google/resolve";
const TIMEOUT_MS = 3_000;
const SOA = 6;
const NS = 2;

type DohRecord = { name?: unknown; type?: unknown; data?: unknown };
type DohAnswer = { Status?: unknown; Answer?: DohRecord[]; Authority?: DohRecord[] };

async function doh(name: string, type: "SOA" | "NS", fetchImpl: typeof fetch): Promise<DohAnswer> {
  const url = `${DOH}?name=${encodeURIComponent(name)}&type=${type}`;
  const res = await fetchImpl(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`DoH ${res.status}`);
  return (await res.json()) as DohAnswer;
}

const bare = (s: string) => s.toLowerCase().replace(/\.$/, "");

/**
 * The zone that holds `name`: the owner of the SOA record in the answer, or in the authority section when `name`
 * itself has no records (the usual case for _hirakumi.<host> before it is added). Asking for the record's own name,
 * not the host, keeps a host that is a CNAME (to Vercel, a CDN) from answering with the target's zone. A wildcard
 * CNAME can still lead elsewhere, so a zone that is not `name` or one of its parents is ignored.
 */
export function zoneOf(answer: DohAnswer, name: string): string | null {
  const n = bare(name);
  const soa = [...(answer.Answer ?? []), ...(answer.Authority ?? [])].find((r) => {
    if (r.type !== SOA || typeof r.name !== "string") return false;
    const z = bare(r.name);
    return n === z || n.endsWith(`.${z}`);
  });
  return soa ? bare(soa.name as string) : null;
}

/** The platform suffix the host sits under (vercel.app for x.vercel.app), from the Public Suffix List's private section. */
export function sharedSuffixOf(host: string): string | null {
  const p = parse(host, { allowPrivateDomains: true });
  return p.isPrivate && p.publicSuffix ? p.publicSuffix : null;
}

/**
 * Where the seller adds the record: the zone and its DNS provider, for the ownership panel's steps. A failed lookup
 * leaves zone and provider null: the panel then shows the general steps. Only a hint; the gateway's TXT lookup is
 * what proves ownership.
 */
export async function probeDns(host: string, recordName: string, fetchImpl: typeof fetch = fetch): Promise<DnsSetup> {
  const suffix = sharedSuffixOf(host);
  let soaZone: string | null = null;
  try {
    soaZone = zoneOf(await doh(recordName, "SOA", fetchImpl), recordName);
  } catch {
    // A hint only: the panel falls back to the general steps.
  }
  // Under a private suffix with no zone of its own below it: the platform's DNS, not the seller's.
  if (suffix && (soaZone === null || soaZone === suffix)) return { zone: soaZone, provider: null, sharedSuffix: suffix };
  // Without an SOA inside the name (a wildcard CNAME, a failed lookup), the registrable domain is the likely zone.
  const zone = soaZone ?? parse(host).domain ?? null;
  if (!zone) return { zone: null, provider: null, sharedSuffix: null };
  try {
    const ns = await doh(zone, "NS", fetchImpl);
    const servers = (ns.Answer ?? []).filter((r) => r.type === NS && typeof r.data === "string").map((r) => r.data as string);
    return { zone, provider: providerFromNameservers(servers), sharedSuffix: null };
  } catch {
    return { zone, provider: null, sharedSuffix: null };
  }
}
