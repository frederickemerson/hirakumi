import { describe, expect, it } from "vitest";
import { providerFromNameservers, providerName, relativeName } from "./dns-provider";

describe("providerFromNameservers", () => {
  it.each([
    [["jule.ns.cloudflare.com.", "kirk.ns.cloudflare.com."], "cloudflare"],
    [["ns1.vercel-dns.com", "ns2.vercel-dns.com"], "vercel"],
    [["ns1.vercel-dns-3.com."], "vercel"],
    [["ns-1.awsdns-01.org", "ns-2.awsdns-02.co.uk", "ns-3.awsdns-03.com", "ns-4.awsdns-04.net"], "route53"],
    [["ns13.domaincontrol.com"], "godaddy"],
    [["dns1.registrar-servers.com.", "dns2.registrar-servers.com."], "namecheap"],
    [["maceio.ns.porkbun.com.", "curitiba.ns.porkbun.com."], "porkbun"],
    [["ns-cloud-a1.googledomains.com."], "gcloud"],
  ] as const)("%j is %s", (ns, id) => {
    expect(providerFromNameservers(ns)).toBe(id);
  });

  it("is null for an unknown provider, a mix of two, or none", () => {
    expect(providerFromNameservers(["nebula.dns-parking.com."])).toBeNull();
    expect(providerFromNameservers(["ns1.vercel-dns.com", "jule.ns.cloudflare.com"])).toBeNull();
    expect(providerFromNameservers(["jule.ns.cloudflare.com", "ns1.p01.dynect.net"])).toBeNull();
    expect(providerFromNameservers([])).toBeNull();
  });

  it("does not match a look-alike name", () => {
    expect(providerFromNameservers(["ns.cloudflare.com.evil.example"])).toBeNull();
  });

  it("names the provider", () => {
    expect(providerName("route53")).toBe("Amazon Route 53");
  });
});

describe("relativeName", () => {
  it("is the part before the zone, the label alone at the apex, and the full name outside it", () => {
    expect(relativeName("_hirakumi.api.example.com", "example.com")).toBe("_hirakumi.api");
    expect(relativeName("_hirakumi.example.com", "example.com.")).toBe("_hirakumi");
    expect(relativeName("_hirakumi.api.example.com", "other.com")).toBe("_hirakumi.api.example.com");
    expect(relativeName("_hirakumi.api.notexample.com", "example.com")).toBe("_hirakumi.api.notexample.com");
  });
});
