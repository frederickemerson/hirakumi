import { describe, expect, it, vi } from "vitest";
import { probeDns, sharedSuffixOf, zoneOf } from "./probe-dns";

/** A fake DoH: answers by name and type, recorded from dns.google. */
function doh(answers: Record<string, unknown>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    const a = answers[`${u.searchParams.get("name")} ${u.searchParams.get("type")}`];
    return a ? new Response(JSON.stringify(a), { headers: { "content-type": "application/dns-json" } }) : new Response("", { status: 500 });
  }) as unknown as typeof fetch;
}
const soaAuthority = (zone: string) => ({ Status: 0, Authority: [{ name: `${zone}.`, type: 6, data: "ns1 hostmaster 1 7200 900 1209600 86400" }] });
const ns = (zone: string, servers: string[]) => ({ Status: 0, Answer: servers.map((s) => ({ name: `${zone}.`, type: 2, data: `${s}.` })) });

describe("zoneOf", () => {
  it("takes the SOA owner in the authority section", () => {
    expect(zoneOf(soaAuthority("example.com"), "_hirakumi.api.example.com")).toBe("example.com");
  });
  it("ignores an SOA outside the name, as a wildcard CNAME gives", () => {
    const viaWildcard = {
      Status: 0,
      Answer: [{ name: "_hirakumi.api.karencode.xyz.", type: 5, data: "b08d.vercel-dns-017.com." }],
      Authority: [{ name: "vercel-dns-017.com.", type: 6, data: "ns1 hostmaster 1 3600 900 1209600 900" }],
    };
    expect(zoneOf(viaWildcard, "_hirakumi.api.karencode.xyz")).toBeNull();
  });
});

describe("sharedSuffixOf", () => {
  it("is the platform suffix for a host on a shared domain, null for an own domain", () => {
    expect(sharedSuffixOf("mine.vercel.app")).toBe("vercel.app");
    expect(sharedSuffixOf("x.herokuapp.com")).toBe("herokuapp.com");
    expect(sharedSuffixOf("api.example.co.uk")).toBeNull();
  });
});

describe("probeDns", () => {
  it("finds the zone and its provider", async () => {
    const f = doh({
      "_hirakumi.api.example.com SOA": soaAuthority("example.com"),
      "example.com NS": ns("example.com", ["jule.ns.cloudflare.com", "kirk.ns.cloudflare.com"]),
    });
    expect(await probeDns("api.example.com", "_hirakumi.api.example.com", f)).toEqual({ zone: "example.com", provider: "cloudflare", sharedSuffix: null });
  });

  it("falls back to the registrable domain when the SOA leads elsewhere", async () => {
    const f = doh({
      "_hirakumi.api.karencode.xyz SOA": { Status: 0, Authority: [{ name: "vercel-dns-017.com.", type: 6, data: "x" }] },
      "karencode.xyz NS": ns("karencode.xyz", ["maceio.ns.porkbun.com", "salvador.ns.porkbun.com"]),
    });
    expect(await probeDns("api.karencode.xyz", "_hirakumi.api.karencode.xyz", f)).toEqual({ zone: "karencode.xyz", provider: "porkbun", sharedSuffix: null });
  });

  it("flags a platform's shared domain", async () => {
    const f = doh({ "_hirakumi.mine.vercel.app SOA": soaAuthority("vercel.app") });
    expect(await probeDns("mine.vercel.app", "_hirakumi.mine.vercel.app", f)).toEqual({ zone: "vercel.app", provider: null, sharedSuffix: "vercel.app" });
  });

  it("never throws: a failed lookup gives the likely zone and no provider", async () => {
    const f = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await probeDns("api.example.com", "_hirakumi.api.example.com", f)).toEqual({ zone: "example.com", provider: null, sharedSuffix: null });
  });
});
