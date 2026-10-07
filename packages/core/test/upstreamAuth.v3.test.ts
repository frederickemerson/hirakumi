import { describe, expect, it } from "vitest";
import {
  generateUpstreamAuthKeys, isUpstreamBag, MAX_UPSTREAM_LEAK_NEEDLES, openUpstreamBag, openUpstreamSecret, publicKeyFromPrivate, sealUpstreamBag,
  UpstreamAddressChangedError, UpstreamAuthError, upstreamBagContext, validateUpstreamBag,
  type UpstreamBag, type UpstreamBagContext, type UpstreamPartPlacement,
} from "../src/upstreamAuth";

const keys = generateUpstreamAuthKeys();
const KEY = "sb_secret_0123456789abcdefWXYZ";
const PARTS: UpstreamPartPlacement[] = [{ in: "header", name: "apikey" }, { in: "header", name: "Authorization" }];
const CTX: UpstreamBagContext = { apiId: "api_1", parts: PARTS, origin: "https://api.example.com", pathPrefix: "/v1" };
const BAG: UpstreamBag = { values: [KEY, `Bearer ${KEY}`], fixed: [], leak: [KEY, `Bearer ${KEY}`] };
const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("sealed bags (hks3)", () => {
  it("round-trips, opens at the canonical address, and every seal is different", () => {
    const a = sealUpstreamBag(keys.publicKey, CTX, BAG);
    const b = sealUpstreamBag(keys.publicKey, CTX, BAG);
    expect(a).not.toBe(b);
    expect(a.startsWith("hks3.")).toBe(true);
    expect(a).not.toContain(KEY);
    expect(openUpstreamBag(keys.privateKey, CTX, a)).toEqual(BAG);
    // Sealed at /v1, opens at /v1/; a trailing slash or default port on the origin and header case do not matter.
    const same = { ...CTX, origin: "https://API.example.com:443/", pathPrefix: "/v1/", parts: [{ in: "header" as const, name: "APIKEY" }, PARTS[1]!] };
    expect(openUpstreamBag(keys.privateKey, same, a)).toEqual(BAG);
  });

  it("binds a canonical, versioned context", () => {
    expect(upstreamBagContext({ ...CTX, parts: [{ in: "header", name: " ApiKey " }, { in: "query", name: "Key" }], pathPrefix: "/" }))
      .toBe('["hks3","api_1",[["header","apikey"],["query","Key"]],"https://api.example.com",""]');
  });

  it("does not open when a part is moved, renamed, reordered, added or removed, or for another API or private key", () => {
    const sealed = sealUpstreamBag(keys.publicKey, CTX, BAG);
    const others: UpstreamBagContext[] = [
      { ...CTX, parts: [PARTS[1]!, PARTS[0]!] },
      { ...CTX, parts: [{ in: "header", name: "x-apikey" }, PARTS[1]!] },
      { ...CTX, parts: [{ in: "query", name: "apikey" }, PARTS[1]!] },
      { ...CTX, parts: [...PARTS, { in: "query", name: "k" }] },
      { ...CTX, parts: [PARTS[0]!] },
      { ...CTX, apiId: "api_2" },
    ];
    for (const other of others) {
      expect(() => openUpstreamBag(keys.privateKey, other, sealed), JSON.stringify(other)).toThrow(UpstreamAuthError);
      expect(() => openUpstreamBag(keys.privateKey, other, sealed)).not.toThrow(UpstreamAddressChangedError);
    }
    expect(() => openUpstreamBag(generateUpstreamAuthKeys().privateKey, CTX, sealed)).toThrow(UpstreamAuthError);
  });

  it("says when the origin or path prefix changed", () => {
    const sealed = sealUpstreamBag(keys.publicKey, CTX, BAG);
    for (const moved of [{ origin: "https://evil.example.com" }, { pathPrefix: "/v2" }, { pathPrefix: "" }]) {
      expect(() => openUpstreamBag(keys.privateKey, { ...CTX, ...moved }, sealed), JSON.stringify(moved)).toThrow(UpstreamAddressChangedError);
    }
  });

  it("a bag relabelled as hks2, or an hks2 key read as a bag, does not open", () => {
    const sealed = sealUpstreamBag(keys.publicKey, CTX, BAG);
    const relabelled = ["hks2", ...sealed.split(".").slice(1)].join(".");
    expect(() => openUpstreamSecret(keys.privateKey, { apiId: "api_1", in: "header", name: "apikey", origin: CTX.origin, pathPrefix: "/v1" }, relabelled))
      .toThrow(UpstreamAuthError);
    expect(() => openUpstreamBag(keys.privateKey, CTX, relabelled)).toThrow(UpstreamAuthError);
    const tampered = sealed.split(".");
    const ct = Buffer.from(tampered[4]!, "base64url");
    ct[0] ^= 1;
    tampered[4] = ct.toString("base64url");
    expect(() => openUpstreamBag(keys.privateKey, CTX, tampered.join("."))).toThrow(UpstreamAuthError);
  });

  it("refuses a bag over 8 KB at sealing", () => {
    expect(() => sealUpstreamBag(keys.publicKey, CTX, { values: ["x".repeat(4096), "y".repeat(4096)], fixed: [], leak: [] })).toThrow(UpstreamAuthError);
  });

  it("tells stored bags from stored keys", () => {
    expect(isUpstreamBag({ v: 3, parts: [], sealed: "hks3.x" })).toBe(true);
    expect(isUpstreamBag({ in: "header", name: "X-Key", sealed: "hks2.x", hint: "" })).toBe(false);
  });

  it("publicKeyFromPrivate gives the matching public key, and throws on garbage", () => {
    expect(publicKeyFromPrivate(keys.privateKey)).toBe(keys.publicKey);
    expect(publicKeyFromPrivate(keys.privateKey)).not.toBe(generateUpstreamAuthKeys().publicKey);
    expect(() => publicKeyFromPrivate("bm90IGEga2V5")).toThrow();
  });
});

describe("validateUpstreamBag", () => {
  it("accepts a valid bag and returns the parts in order, trimmed", () => {
    const v = validateUpstreamBag(PARTS, { ...BAG, values: [` ${KEY} `, `Bearer ${KEY}`] });
    expect(v.parts).toEqual([{ in: "header", name: "apikey", value: KEY }, { in: "header", name: "Authorization", value: `Bearer ${KEY}` }]);
    expect(v.leakParts).toEqual([KEY, `Bearer ${KEY}`]);
  });

  it("allows fixed text of one character, never looks for it in answers, and does not need it in the leak list", () => {
    const v = validateUpstreamBag(
      [{ in: "header", name: "X-Key" }, { in: "header", name: "Notion-Version" }, { in: "query", name: "v" }],
      { values: [KEY, "2022-06-28", "1"], fixed: [1, 2], leak: [] },
    );
    expect(v.parts.map((p) => p.value)).toEqual([KEY, "2022-06-28", "1"]);
    expect(v.leakParts).toEqual([KEY]);
  });

  const refused: [string, UpstreamPartPlacement[], UpstreamBag][] = [
    ["5 parts", Array.from({ length: 5 }, (_, i) => ({ in: "header" as const, name: `X-K${i}` })), { values: Array(5).fill(KEY), fixed: [], leak: [] }],
    ["no parts", [], { values: [], fixed: [], leak: [] }],
    ["values and parts differ in number", PARTS, { values: [KEY], fixed: [], leak: [] }],
    ["a CRLF value", PARTS, { values: [`${KEY}\r\nHost: evil`, KEY], fixed: [], leak: [] }],
    ["a reserved header", [{ in: "header", name: "Host" }], { values: [KEY], fixed: [], leak: [] }],
    ["accept-encoding", [{ in: "header", name: "Accept-Encoding" }, PARTS[0]!], { values: ["gzip", KEY], fixed: [0], leak: [] }],
    ["a duplicate header in another case", [{ in: "header", name: "X-Key" }, { in: "header", name: "x-key" }], { values: [KEY, KEY], fixed: [], leak: [] }],
    ["a duplicate query name", [{ in: "query", name: "k" }, { in: "query", name: "k" }], { values: [KEY, KEY], fixed: [], leak: [] }],
    ["every part fixed", PARTS, { values: ["a", "b"], fixed: [0, 1], leak: [] }],
    ["a fixed index out of range", PARTS, { values: [KEY, KEY], fixed: [2], leak: [] }],
    ["a short secret", PARTS, { values: ["short", KEY], fixed: [], leak: [] }],
    ["a leak entry of 7 characters", PARTS, { ...BAG, leak: ["1234567"] }],
    ["a leak entry over 4096 characters", PARTS, { ...BAG, leak: ["x".repeat(4097)] }],
    ["9 leak entries", PARTS, { ...BAG, leak: Array.from({ length: 9 }, (_, i) => `${KEY}${i}`) }],
  ];
  for (const [name, parts, bag] of refused) {
    it(`refuses ${name}`, () => expect(() => validateUpstreamBag(parts, bag)).toThrow(UpstreamAuthError));
  }

  it(`refuses more than ${MAX_UPSTREAM_LEAK_NEEDLES} forms to look for`, () => {
    // Characters that every escaping writes differently, so each entry has many forms.
    const awkward = (i: number) => `k<&>"'/+ =${i}${"a".repeat(20)}`;
    expect(() => validateUpstreamBag(PARTS, { ...BAG, leak: Array.from({ length: 8 }, (_, i) => awkward(i)) })).toThrow(/too long or unusual/);
    // An ordinary bag is far under the cap.
    expect(() => validateUpstreamBag(PARTS, BAG)).not.toThrow();
  });

  it("derives a Basic password and pair itself when the leak list leaves them out, but never the user name", () => {
    const value = `Basic ${b64("alice_public:s3cr3tpass")}`;
    const v = validateUpstreamBag([{ in: "header", name: "Authorization" }], { values: [value], fixed: [], leak: [] });
    expect(v.leakParts).toEqual([value, "s3cr3tpass", "alice_public:s3cr3tpass"]);
    expect(v.leakParts).not.toContain("alice_public");
  });

  it("derives the K of Bearer K and Token K itself (8 characters or more)", () => {
    const v = validateUpstreamBag([{ in: "header", name: "Authorization" }, { in: "header", name: "X-Token" }], {
      values: [`Bearer ${KEY}`, "Token tok_12345678"], fixed: [], leak: [],
    });
    expect(v.leakParts).toEqual([`Bearer ${KEY}`, "Token tok_12345678", KEY, "tok_12345678"]);
    const short = validateUpstreamBag([{ in: "header", name: "Authorization" }], { values: ["Bearer abc1234"], fixed: [], leak: [] });
    expect(short.leakParts).toEqual(["Bearer abc1234"]);
  });
});
