// Property tests for the gateway's network-facing pure functions: SSRF address blocking, the upstream request
// builder (path traversal, key override, header injection), bearer parsing, ownership URL and header checks,
// MIP-003 input and rate-limit keys, listing bases, and the settlement policy.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  chooseSettlement, compareBases, isBlockedAddress, matchVerifyHeader, newBearerToken, newVerifyCode, normalizeOrigin,
  ownershipCheckUrl, uptimeFraction, urlCarriesCode, urlWithinBase, DEFAULT_SETTLEMENT_POLICY,
} from "@hirakumi/core";
import { buildUpstreamRequest, normalizeMip003Input } from "../../apps/gateway/src/upstream";
import { parseBearer } from "../../apps/gateway/src/http";
import { clientKey } from "../../apps/gateway/src/mip003";
import { runs } from "./runs";

const byte = fc.integer({ min: 0, max: 255 });
const hex4 = (n: number) => n.toString(16);

/** IPv4 addresses inside every range the gateway must never call. */
const PRIVATE_V4: [number, number, number, number, number][] = [
  [0, 0, 0, 0, 8], [10, 0, 0, 0, 8], [100, 64, 0, 0, 10], [127, 0, 0, 0, 8], [169, 254, 0, 0, 16], [172, 16, 0, 0, 12],
  [192, 0, 0, 0, 24], [192, 168, 0, 0, 16], [198, 18, 0, 0, 15], [224, 0, 0, 0, 4], [240, 0, 0, 0, 4],
];
const privateV4 = fc.tuple(fc.constantFrom(...PRIVATE_V4), fc.integer({ min: 0, max: 2 ** 32 - 1 })).map(([[a, b, c, d, p], r]) => {
  const base = ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
  const mask = p === 0 ? 0 : (2 ** 32 - 2 ** (32 - p));
  const n = ((base & mask) >>> 0) + (r % 2 ** (32 - p));
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255] as const;
});

/** Every textual form of an IPv4 address embedded in IPv6 that resolvers or users may produce. */
function v6Forms([a, b, c, d]: readonly number[]): string[] {
  const dotted = `${a}.${b}.${c}.${d}`;
  const hi = hex4((a << 8) | b), lo = hex4((c << 8) | d);
  const pad = (s: string) => s.padStart(4, "0");
  return [
    `::ffff:${dotted}`, `::FFFF:${dotted}`, `0:0:0:0:0:ffff:${dotted}`, `0000:0000:0000:0000:0000:ffff:${dotted}`,
    `::ffff:${hi}:${lo}`, `::FFFF:${pad(hi).toUpperCase()}:${pad(lo)}`, `0:0:0:0:0:ffff:${hi}:${lo}`,
    `0000:0000:0000:0000:0000:FFFF:${pad(hi)}:${pad(lo)}`,
    `::ffff:0:${dotted}`, `::ffff:0:${hi}:${lo}`, `0:0:0:0:ffff:0:${hi}:${lo}`,
    `64:ff9b::${dotted}`, `64:ff9b::${hi}:${lo}`,
  ];
}

describe("isBlockedAddress (SSRF)", () => {
  it("every private IPv4 address is blocked, dotted and in every IPv6 embedding", () => {
    fc.assert(fc.property(privateV4, (ip) => {
      expect(isBlockedAddress(ip.join("."))).toBe(true);
      for (const f of v6Forms(ip)) expect(isBlockedAddress(f), f).toBe(true);
    }), runs(2000));
  });

  it("private IPv6 ranges (loopback, ULA, link-local, multicast, site-local, 6to4, Teredo) in any case and expansion", () => {
    const ranges: [number, number][] = [[0xfc00, 7], [0xfe80, 10], [0xff00, 8], [0xfec0, 10], [0x2002, 16]];
    fc.assert(fc.property(fc.constantFrom(...ranges), fc.array(fc.integer({ min: 0, max: 0xffff }), { minLength: 8, maxLength: 8 }), fc.boolean(), fc.boolean(),
      ([net, p], groups, upper, expand) => {
        const keep = 16 - p;
        groups[0] = (net & ~((1 << keep) - 1) & 0xffff) | (groups[0]! & ((1 << keep) - 1));
        let s = groups.map((g) => (expand ? g.toString(16).padStart(4, "0") : g.toString(16))).join(":");
        if (upper) s = s.toUpperCase();
        expect(isBlockedAddress(s), s).toBe(true);
      }), runs(1000));
    for (const s of ["::1", "0:0:0:0:0:0:0:1", "0000:0000:0000:0000:0000:0000:0000:0001", "::", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "100::1", "2001:db8::1", "::7f00:1", "::127.0.0.1"]) {
      expect(isBlockedAddress(s), s).toBe(true);
    }
  });

  it("garbage, zero-padded, octal, hex and decimal-integer IPv4 spellings are blocked (never resolved as public)", () => {
    for (const s of ["127.000.000.001", "0177.0.0.1", "0x7f.0.0.1", "2130706433", "127.1", "", "localhost", "1.2.3.4.5", "[::1]", "::ffff:127.0.0.1%eth0", "fe80::1%lo0"]) {
      expect(isBlockedAddress(s), s).toBe(true);
    }
    fc.assert(fc.property(fc.string(), (s) => { expect(() => isBlockedAddress(s)).not.toThrow(); }), runs(2000));
  });

  it("public addresses stay allowed (no blanket refusal)", () => {
    for (const s of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "::ffff:808:808"]) expect(isBlockedAddress(s), s).toBe(false);
  });
});

describe("buildUpstreamRequest", () => {
  const api = (credential?: { in: "header" | "query"; name: string; value: string }) =>
    ({ origin: "https://api.seller.test", path_prefix: "/v1/tenant-a", ...(credential ? { credential } : {}) });
  const nasty = fc.oneof(fc.string(), fc.fullUnicodeString(), fc.constantFrom(
    "..", ".", "%2e%2e", "%2E%2e", "..%2f", "%2f", "%5c", "\\", "/", "a/../b", "..;", "%252e%252e", "．．", "\r\nX-Evil: 1",
    "%0d%0aX-Evil:1", "?x=1", "#frag", "@evil.test", "//evil.test", "a b", "\u0000", "%00", "~", "%",
  ));

  it("a path parameter never takes the URL outside the proven folder, and fills exactly one segment", () => {
    fc.assert(fc.property(nasty, nasty, (a, b) => {
      let r;
      try { r = buildUpstreamRequest(api(), { method: "GET", path: "/items/{id}/sub/{name}" }, { id: a, name: b }); }
      catch (e) { expect((e as Error).message).toMatch(/invalid path parameter|missing path parameter|blocked/); return; }
      const u = new URL(r.url);
      expect(urlWithinBase(u, "https://api.seller.test", "/v1/tenant-a")).toBe(true);
      const segs = u.pathname.split("/");
      expect(segs.length).toBe(7); // "", v1, tenant-a, items, <id>, sub, <name>
      expect(segs[3]).toBe("items"); expect(segs[5]).toBe("sub");
      for (const s of [segs[4]!, segs[6]!]) {
        const d = decodeURIComponent(s);
        expect(d === "." || d === ".." || /[/\\]/.test(d)).toBe(false);
      }
      expect(u.host).toBe("api.seller.test");
      expect(u.hash).toBe("");
    }), runs(3000));
  });

  it("buyer input never overrides or duplicates the seller's key, in the query or a header", () => {
    fc.assert(fc.property(fc.constantFrom("api_key", "apikey", "key", "Authorization", "x-api-key"), fc.dictionary(fc.string(), nasty, { maxKeys: 5 }),
      fc.constantFrom<"header" | "query">("header", "query"), fc.oneof(nasty, fc.array(nasty, { maxLength: 3 })),
      (name, extra, where, attack) => {
        const cred = { in: where, name, value: "SELLER_SECRET_123456" };
        const input = { ...extra, [name]: attack, [name.toLowerCase()]: attack, [name.toUpperCase()]: attack };
        let r;
        try { r = buildUpstreamRequest(api(cred), { method: "GET", path: "/q" }, input); } catch { return; }
        const u = new URL(r.url);
        if (where === "query") {
          expect(u.searchParams.getAll(name)).toEqual(["SELLER_SECRET_123456"]);
        } else {
          expect(r.init.headers[name.toLowerCase()]).toBe("SELLER_SECRET_123456");
        }
        // Buyer input becomes query only: never a header, never raw CR/LF or spaces in the URL.
        expect(Object.keys(r.init.headers).sort()).toEqual(["accept", "user-agent", "x-hirakumi-hop", ...(where === "header" ? [name.toLowerCase()] : [])].sort());
        expect(r.url).not.toMatch(/[\r\n\s]/);
        for (const v of Object.values(r.init.headers)) expect(v).not.toMatch(/[\r\n]/);
      }), runs(2000));
  });

  it("POST body is exactly the `body` field as JSON; GET never sends one", () => {
    fc.assert(fc.property(fc.jsonValue(), fc.constantFrom("GET", "POST", "PUT", "DELETE", "HEAD"), (body, method) => {
      const r = buildUpstreamRequest(api(), { method, path: "/x" }, { body, q: "1" });
      // A JSON null is a body too ("null"); only a missing `body` field sends none.
      if (method === "GET" || method === "HEAD") expect(r.init.body).toBeUndefined();
      else expect(JSON.parse(r.init.body!)).toEqual(JSON.parse(JSON.stringify(body)));
    }), runs(500));
  });
});

describe("parseBearer", () => {
  // The scheme is matched case-sensitively on purpose (adversarial.credits.test.ts: a lowercase scheme gets 401).
  it("accepts exactly hk_ + 43 base64url characters after 'Bearer'", () => {
    fc.assert(fc.property(fc.constantFrom("Bearer"), fc.constantFrom(" ", "  ", "\t"), (scheme, sp) => {
      const t = newBearerToken();
      expect(parseBearer(`${scheme}${sp}${t}`)).toBe(t);
      expect(parseBearer(` Bearer ${t} `)).toBe(t);
      expect(parseBearer(`Bearer ${t}x`)).toBeNull();
      expect(parseBearer(`Bearer ${t.slice(0, -1)}`)).toBeNull();
      expect(parseBearer(`Bearer ${t},Bearer ${t}`)).toBeNull();
      expect(parseBearer(t)).toBeNull();
      expect(parseBearer(`bearer ${t}`)).toBeNull();
    }), runs(200));
    fc.assert(fc.property(fc.string({ maxLength: 120 }), (s) => {
      const r = parseBearer(s);
      if (r !== null) expect(r).toMatch(/^hk_[A-Za-z0-9_-]{43}$/);
    }), runs(3000));
    expect(parseBearer(undefined)).toBeNull();
  });
});

describe("ownership checks", () => {
  it("matchVerifyHeader: the code anywhere in a repeated or comma-joined header matches; others never do", () => {
    fc.assert(fc.property(fc.array(fc.string(), { maxLength: 4 }), fc.nat(4), (noise, at) => {
      const code = newVerifyCode();
      const vals = [...noise.map((n) => n.replaceAll(code, ""))];
      vals.splice(Math.min(at, vals.length), 0, ` ${code} `);
      expect(matchVerifyHeader(vals, code)).toBe("match");
      expect(matchVerifyHeader(vals.join(","), code)).toBe("match");
      expect(matchVerifyHeader(noise.filter((n) => !n.split(",").some((p) => p.trim() === code)), code)).not.toBe("match");
      expect(matchVerifyHeader(code.toUpperCase(), code)).toBe("mismatch");
      expect(matchVerifyHeader(code.slice(0, -1), code)).toBe("mismatch");
    }), runs(300));
  });

  it("ownershipCheckUrl never returns ok for a URL that carries the code or leaves its base", () => {
    fc.assert(fc.property(fc.string({ maxLength: 30 }), fc.boolean(), (junk, embed) => {
      const code = newVerifyCode();
      const prefix = `/${embed ? code.slice(4, 20) : ""}${junk}`;
      const r = ownershipCheckUrl({ origin: "https://api.seller.test", pathPrefix: prefix, code });
      if (r.ok) {
        const u = new URL(r.url);
        expect(u.origin).toBe("https://api.seller.test");
        expect(u.search).toBe("");
        expect(u.hash).toBe("");
        expect(urlCarriesCode(r.url, code)).toBe(false);
        expect(urlWithinBase(u, "https://api.seller.test", prefix)).toBe(true);
      }
      if (embed) expect(r.ok).toBe(false);
    }), runs(2000));
  });

  it("urlWithinBase: sibling folders sharing a name prefix are outside", () => {
    expect(urlWithinBase(new URL("https://a.test/v1/tenant-ab/x"), "https://a.test", "/v1/tenant-a")).toBe(false);
    expect(urlWithinBase(new URL("https://a.test/v1/tenant-a/x"), "https://a.test", "/v1/tenant-a/")).toBe(true);
    expect(urlWithinBase(new URL("https://a.test.evil/v1/tenant-a"), "https://a.test", "/v1/tenant-a")).toBe(false);
  });
});

describe("MIP-003 input and start_job rate-limit keys", () => {
  it("normalizeMip003Input: lists become objects, garbage becomes null, never throws", () => {
    fc.assert(fc.property(fc.anything(), (v) => {
      let r: ReturnType<typeof normalizeMip003Input> = null;
      expect(() => { r = normalizeMip003Input(v); }).not.toThrow();
      if (r !== null) expect(typeof r).toBe("object");
    }), runs(2000));
    // "__proto__" is the known bug below (it.fails), so it is left out here.
    fc.assert(fc.property(fc.array(fc.tuple(fc.string().filter((k) => k !== "__proto__"), fc.jsonValue())), (kv) => {
      const r = normalizeMip003Input(kv.map(([key, value]) => ({ key, value })));
      expect(r).not.toBeNull();
      for (const [k, v] of kv) if (kv.filter(([kk]) => kk === k).at(-1)![1] === v) expect(Object.hasOwn(r!, k)).toBe(true);
    }), runs(1000));
  });

  // A list item {key: "__proto__", value: {...}} assigned with out[key] = value sets the prototype instead of a field:
  // the input is then missing that field, and inherited fields appear present to `in` checks.
  // Was a bug (fixed): out[key] = value made [{key:"__proto__", value:{symbol:"ADA"}}] the object's prototype, so
  // input validation saw `symbol` while the upstream request, which spreads own fields only, sent none.
  it("a [{key: '__proto__'}] item becomes an own field, not the prototype", () => {
    const r = normalizeMip003Input([{ key: "__proto__", value: { polluted: true } }, { key: "symbol", value: "ADA" }])!;
    expect(Object.getPrototypeOf(r)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(r, "__proto__")).toBe(true);
  });

  it("clientKey: every spelling of an address in one IPv6 /64 is one key; IPv4 and mapped IPv4 agree", () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 0xffff }), { minLength: 8, maxLength: 8 }), fc.array(fc.integer({ min: 0, max: 0xffff }), { minLength: 4, maxLength: 4 }),
      fc.boolean(), (g, tail, upper) => {
        fc.pre(g.some((x) => x !== 0));
        const full = g.map((x) => x.toString(16).padStart(4, "0")).join(":");
        const other = [...g.slice(0, 4), ...tail].map((x) => x.toString(16)).join(":");
        const k = clientKey(full);
        expect(clientKey(upper ? other.toUpperCase() : other)).toBe(k);
        // Compressed form of the same address.
        const comp = g.map((x) => x.toString(16)).join(":").replace(/(^|:)0(:0)+(:|$)/, "::");
        expect(clientKey(comp)).toBe(k);
      }), runs(2000));
    fc.assert(fc.property(byte, byte, byte, byte, (a, b, c, d) => {
      expect(clientKey(`::ffff:${a}.${b}.${c}.${d}`)).toBe(`${a}.${b}.${c}.${d}`);
    }), runs(300));
  });
});

describe("listing bases", () => {
  it("normalizeOrigin agrees with URL parsing on case, default ports and a trailing host dot", () => {
    fc.assert(fc.property(fc.domain(), fc.constantFrom("", ":443", ":8443"), fc.boolean(), fc.boolean(), (host, port, upper, dot) => {
      const raw = `https://${upper ? host.toUpperCase() : host}${dot ? "." : ""}${port}`;
      const plain = `https://${host}${port === ":443" ? "" : port}`;
      expect(normalizeOrigin(raw)).toBe(normalizeOrigin(plain));
      expect(normalizeOrigin(normalizeOrigin(raw))).toBe(normalizeOrigin(raw));
      expect(compareBases({ origin: raw, pathPrefix: "/v1" }, { origin: plain, pathPrefix: "/v1/" })).toBe("exact");
      expect(compareBases({ origin: raw, pathPrefix: "/v1" }, { origin: plain, pathPrefix: "/v10" })).toBe(null);
      expect(compareBases({ origin: raw, pathPrefix: "/" }, { origin: plain, pathPrefix: "/v10" })).toBe("overlap");
    }), runs(1000));
  });
});

describe("settlement policy", () => {
  const input = fc.record({
    priceMicros: fc.bigInt({ min: 0n, max: 10n ** 9n }), sellerUptime7d: fc.double({ min: 0, max: 1, noNaN: true }),
    listingAgeDays: fc.double({ min: 0, max: 400, noNaN: true }), buyerCanEscrow: fc.boolean(), buyerWantsEscrow: fc.boolean(),
  });
  it("pure, and riskier inputs never move a purchase from escrow to direct", () => {
    fc.assert(fc.property(input, fc.bigInt({ min: 0n, max: 10n ** 9n }), fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 400, noNaN: true }),
      (i, morePrice, lessUptime, lessAge) => {
        const a = chooseSettlement(i);
        expect(chooseSettlement(i)).toEqual(a);
        if (!i.buyerCanEscrow) { expect(a).toEqual({ mode: "direct", reasons: ["buyer sent no receipt key"] }); return; }
        if (i.buyerWantsEscrow) expect(a.mode).toBe("escrow");
        const riskier = { ...i, priceMicros: i.priceMicros + morePrice, sellerUptime7d: Math.min(i.sellerUptime7d, lessUptime), listingAgeDays: Math.min(i.listingAgeDays, lessAge) };
        if (a.mode === "escrow") expect(chooseSettlement(riskier).mode).toBe("escrow");
        expect(a.reasons.length).toBeGreaterThan(0);
        if (i.priceMicros >= DEFAULT_SETTLEMENT_POLICY.escrowFromMicros) expect(a.mode).toBe("escrow");
      }), runs(3000));
  });

  it("uptimeFraction is in [0, 1], 1 without down time, and order of events does not matter", () => {
    const t0 = Date.UTC(2026, 0, 1);
    const ev = fc.record({ to: fc.constantFrom<"healthy" | "down">("healthy", "down"), at: fc.integer({ min: -10 * 86_400_000, max: 20 * 86_400_000 }).map((ms) => new Date(t0 + ms)) });
    fc.assert(fc.property(fc.array(ev, { maxLength: 30 }), fc.constantFrom<"healthy" | "down">("healthy", "down"), fc.integer({ min: -86_400_000, max: 14 * 86_400_000 }),
      (events, startHealth, len) => {
        const w = { from: new Date(t0), to: new Date(t0 + len), startHealth, events };
        const u = uptimeFraction(w);
        expect(u).toBeGreaterThanOrEqual(0);
        expect(u).toBeLessThanOrEqual(1);
        expect(Number.isFinite(u)).toBe(true);
        // Stable sort by time: events at the same instant keep their order, so compare on distinct times only.
        if (new Set(events.map((e) => e.at.getTime())).size === events.length) expect(uptimeFraction({ ...w, events: [...events].reverse() })).toBeCloseTo(u, 12);
        if (startHealth === "healthy" && events.every((e) => e.to === "healthy")) expect(u).toBe(1);
      }), runs(2000));
  });
});
