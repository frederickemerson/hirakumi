/**
 * Where a seller's DNS is hosted, read from the zone's NS records: the nameservers are the provider's own, so they
 * name it exactly. Pure and client-safe: the ownership panel shows the provider's steps, tests feed it nameservers.
 */

export type DnsProviderId =
  | "cloudflare" | "vercel" | "route53" | "godaddy" | "namecheap" | "porkbun" | "gcloud" | "azure" | "digitalocean" | "hetzner" | "gandi";

/**
 * What the ownership page knows about the host's DNS: its zone (the domain the provider manages), the provider, and
 * `sharedSuffix`, set when the zone is a platform's shared domain (vercel.app, herokuapp.com: a private suffix on
 * the Public Suffix List), whose DNS the seller can't edit.
 */
export type DnsSetup = { zone: string | null; provider: DnsProviderId | null; sharedSuffix: string | null };

type Provider = { id: DnsProviderId; name: string; ns: RegExp; where: string };

/** Each provider's nameserver suffix, and where in its dashboard a record is added. */
const PROVIDERS: Provider[] = [
  { id: "cloudflare", name: "Cloudflare", ns: /\.ns\.cloudflare\.com$/, where: "Open your domain in the Cloudflare dashboard, then DNS, Records, Add record." },
  { id: "vercel", name: "Vercel", ns: /\.vercel-dns(-\d+)?\.com$/, where: "In Vercel, open Domains, pick your domain, then Add Record. Or run the command below." },
  { id: "route53", name: "Amazon Route 53", ns: /\.awsdns-\d+\.(com|net|org|co\.uk)$/, where: "In Route 53, open Hosted zones, pick your domain, then Create record." },
  { id: "godaddy", name: "GoDaddy", ns: /\.domaincontrol\.com$/, where: "In GoDaddy, open My Products, then DNS next to your domain, then Add New Record." },
  { id: "namecheap", name: "Namecheap", ns: /\.registrar-servers\.com$/, where: "In Namecheap, open Domain List, Manage, Advanced DNS, then Add New Record." },
  { id: "porkbun", name: "Porkbun", ns: /\.porkbun\.com$/, where: "In Porkbun, open Domain Management, then DNS next to your domain." },
  { id: "gcloud", name: "Google Cloud DNS", ns: /\.googledomains\.com$/, where: "In Google Cloud, open Cloud DNS, pick your zone, then Add standard." },
  { id: "azure", name: "Azure DNS", ns: /\.azure-dns\.(com|net|org|info)$/, where: "In Azure, open DNS zones, pick your domain, then Record set." },
  { id: "digitalocean", name: "DigitalOcean", ns: /\.digitalocean\.com$/, where: "In DigitalOcean, open Networking, Domains, then your domain." },
  { id: "hetzner", name: "Hetzner", ns: /\.(ns\.hetzner\.(com|de)|first-ns\.de|your-server\.de)$/, where: "In Hetzner DNS Console, open your zone, then Add record." },
  { id: "gandi", name: "Gandi", ns: /\.gandi\.net$/, where: "In Gandi, open Domain, your domain, DNS Records, then Add record." },
];

/** The provider all of these nameservers belong to, or null when none or more than one matches. */
export function providerFromNameservers(nameservers: readonly string[]): DnsProviderId | null {
  const ids = new Set<DnsProviderId>();
  for (const raw of nameservers) {
    const ns = raw.toLowerCase().replace(/\.$/, "");
    const p = PROVIDERS.find((x) => x.ns.test(ns));
    if (!p) return null;
    ids.add(p.id);
  }
  return ids.size === 1 ? [...ids][0] : null;
}

export function providerName(id: DnsProviderId): string {
  return PROVIDERS.find((p) => p.id === id)?.name ?? id;
}

export function providerWhere(id: DnsProviderId): string {
  return PROVIDERS.find((p) => p.id === id)?.where ?? "";
}

/**
 * The record's name as DNS dashboards ask for it: relative to the zone ("_hirakumi.api" for
 * _hirakumi.api.example.com in example.com). The full name when it is not inside the zone.
 */
export function relativeName(name: string, zone: string): string {
  const z = zone.toLowerCase().replace(/\.$/, "");
  const n = name.toLowerCase().replace(/\.$/, "");
  return n.endsWith(`.${z}`) ? n.slice(0, -(z.length + 1)) : n;
}
