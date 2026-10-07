import { describe, expect, it } from "vitest";
import {
  answerLeaksSecret, generateUpstreamAuthKeys, keyAppearsIn, openUpstreamSecret, redactUpstreamSecret, sealUpstreamSecret, textLeaksSecret,
  UpstreamAddressChangedError, UpstreamAuthError, upstreamSecretContext, upstreamSecretHint, upstreamSecretParts, validateUpstreamAuth,
  WITHHELD_TEXT, type UpstreamSecretContext,
} from "../src/upstreamAuth";

const keys = generateUpstreamAuthKeys();
const SECRET = "sk_live_0123456789abcdef";

const CTX: UpstreamSecretContext = { apiId: "api_1", in: "header", name: "X-API-Key", origin: "https://api.example.com", pathPrefix: "/v1" };

describe("sealed upstream keys", () => {
  it("round-trips for the same context, and every seal is different", () => {
    const a = sealUpstreamSecret(keys.publicKey, CTX, SECRET);
    const b = sealUpstreamSecret(keys.publicKey, CTX, SECRET);
    expect(a).not.toBe(b);
    expect(a).not.toContain(SECRET);
    expect(a.startsWith("hks2.")).toBe(true);
    expect(openUpstreamSecret(keys.privateKey, CTX, a)).toBe(SECRET);
    // The same place written another way: header names in any case, a trailing slash, a default port.
    expect(openUpstreamSecret(keys.privateKey, { ...CTX, name: "x-api-key", origin: "https://API.example.com:443/", pathPrefix: "/v1/" }, a)).toBe(SECRET);
  });

  it("does not open for another API, placement, name, private key, or after tampering", () => {
    const sealed = sealUpstreamSecret(keys.publicKey, CTX, SECRET);
    for (const other of [{ apiId: "api_2" }, { in: "query" as const }, { name: "X-Other-Key" }]) {
      expect(() => openUpstreamSecret(keys.privateKey, { ...CTX, ...other }, sealed), JSON.stringify(other)).toThrow(UpstreamAuthError);
      expect(() => openUpstreamSecret(keys.privateKey, { ...CTX, ...other }, sealed)).not.toThrow(UpstreamAddressChangedError);
    }
    expect(() => openUpstreamSecret(generateUpstreamAuthKeys().privateKey, CTX, sealed)).toThrow(UpstreamAuthError);
    const parts = sealed.split(".");
    const ct = Buffer.from(parts[4], "base64url");
    ct[0] ^= 1;
    parts[4] = ct.toString("base64url");
    expect(() => openUpstreamSecret(keys.privateKey, CTX, parts.join("."))).toThrow(UpstreamAuthError);
    expect(() => openUpstreamSecret(keys.privateKey, CTX, "nope")).toThrow(UpstreamAuthError);
    // A key sealed in the old format (no address) is not read.
    expect(() => openUpstreamSecret(keys.privateKey, CTX, ["hks1", ...parts.slice(2)].join("."))).toThrow(UpstreamAuthError);
  });

  it("says when the API's origin or path prefix changed since sealing", () => {
    const sealed = sealUpstreamSecret(keys.publicKey, CTX, SECRET);
    for (const moved of [{ origin: "https://evil.example.com" }, { pathPrefix: "/v2" }, { pathPrefix: "" }, { origin: "http://api.example.com" }]) {
      expect(() => openUpstreamSecret(keys.privateKey, { ...CTX, ...moved }, sealed), JSON.stringify(moved)).toThrow(UpstreamAddressChangedError);
    }
    // Swapping in the address tag of the new address does not help: the address is in the associated data too.
    const moved = { ...CTX, pathPrefix: "/v2" };
    const tag = sealUpstreamSecret(keys.publicKey, moved, "x".repeat(8)).split(".")[1];
    const forged = sealed.split(".");
    forged[1] = tag;
    expect(() => openUpstreamSecret(keys.privateKey, moved, forged.join("."))).toThrow(UpstreamAuthError);
    expect(() => openUpstreamSecret(keys.privateKey, moved, forged.join("."))).not.toThrow(UpstreamAddressChangedError);
  });

  it("binds a canonical, versioned context", () => {
    expect(upstreamSecretContext(CTX)).toBe('["hks2","api_1","header","x-api-key","https://api.example.com","/v1"]');
    expect(upstreamSecretContext({ ...CTX, in: "query", name: "Api_Key", pathPrefix: "/" })).toBe('["hks2","api_1","query","Api_Key","https://api.example.com",""]');
  });
});

describe("validateUpstreamAuth", () => {
  it("accepts a header or query key", () => {
    expect(validateUpstreamAuth({ in: "header", name: " X-API-Key ", value: ` ${SECRET} ` })).toEqual({ in: "header", name: "X-API-Key", value: SECRET });
    expect(validateUpstreamAuth({ in: "header", name: "Authorization", value: `Bearer ${SECRET}` }).value).toBe(`Bearer ${SECRET}`);
    expect(validateUpstreamAuth({ in: "query", name: "api_key", value: SECRET }).in).toBe("query");
  });

  it("refuses header injection, reserved headers, bad names and short keys", () => {
    for (const bad of [
      { in: "header", name: "X-Key", value: `${SECRET}\r\nHost: evil` },
      { in: "header", name: "Host", value: SECRET },
      { in: "header", name: "X-Hirakumi-Probe", value: SECRET },
      { in: "header", name: "X Key", value: SECRET },
      { in: "query", name: "body", value: SECRET },
      { in: "query", name: "a&b", value: SECRET },
      { in: "cookie", name: "k", value: SECRET },
      { in: "header", name: "X-Key", value: "short" },
    ]) {
      expect(() => validateUpstreamAuth(bad), JSON.stringify(bad)).toThrow(UpstreamAuthError);
    }
  });
});

describe("answerLeaksSecret and hint", () => {
  it("finds the key as-is or percent-encoded", () => {
    const c = { in: "query" as const, name: "k", value: "abc/def+ghi=jkl" };
    expect(answerLeaksSecret('{"url":"https://x/?k=abc%2Fdef%2Bghi%3Djkl"}', c)).toBe(true);
    expect(answerLeaksSecret("echo abc/def+ghi=jkl", c)).toBe(true);
    expect(answerLeaksSecret('{"price":1}', c)).toBe(false);
    expect(answerLeaksSecret("anything", null)).toBe(false);
  });

  it("finds a bearer token echoed without its scheme", () => {
    const c = { in: "header" as const, name: "Authorization", value: "Bearer sk_abc123def456" };
    expect(answerLeaksSecret('{"error":"invalid token sk_abc123def456"}', c)).toBe(true);
    expect(answerLeaksSecret('{"error":"Bearer token required"}', c)).toBe(false);
  });

  it("finds a short bearer token (4+ characters) on its own, but not short parts of other keys", () => {
    const c = { in: "header" as const, name: "Authorization", value: "Bearer abc1234" };
    expect(upstreamSecretParts(c.value)).toEqual(["Bearer abc1234", "abc1234"]);
    expect(answerLeaksSecret('{"error":"token abc1234 expired"}', c)).toBe(true);
    expect(upstreamSecretParts("Bearer abc")).toEqual(["Bearer abc"]);
    // A key with spaces but no scheme word: only a last part of 8+ characters is looked for alone.
    expect(upstreamSecretParts("my key x1y2")).toEqual(["my key x1y2"]);
  });

  it("matches the key and its parts in any case", () => {
    const c = { in: "header" as const, name: "Authorization", value: "Bearer sk_AbC123dEf456" };
    expect(answerLeaksSecret("invalid token SK_ABC123DEF456", c)).toBe(true);
    expect(answerLeaksSecret("BEARER SK_abc123def456", c)).toBe(true);
    expect(textLeaksSecret("k=SK_ABC123DEF456", "sk_AbC123dEf456")).toBe(true);
  });

  it("finds the key \\u-escaped inside a JSON string (stress finding: the escape is JSON-escaped once more)", () => {
    const key = "hkfake_Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0L";
    const u = [...key].map((ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
    expect(textLeaksSecret(JSON.stringify({ debug: u }), key)).toBe(true);
    expect(textLeaksSecret(JSON.stringify({ a: JSON.stringify({ debug: u }) }), key)).toBe(true);
    // A base64 of that text right after a JSON "\n" escape.
    expect(textLeaksSecret(JSON.stringify({ d: `\n${Buffer.from(u).toString("base64")}` }), key)).toBe(true);
  });

  it("finds the key base64 or base64url encoded", () => {
    const value = "sk_live>?>?0123";
    const c = { in: "header" as const, name: "X-Key", value };
    const b64 = Buffer.from(value).toString("base64");
    const b64url = Buffer.from(value).toString("base64url");
    expect(b64).not.toBe(b64url);
    for (const f of [b64, b64.replace(/=+$/, ""), b64url]) expect(answerLeaksSecret(`{"echo":"${f}"}`, c), f).toBe(true);
    const bearer = { in: "header" as const, name: "Authorization", value: "Bearer sk_abc123def456" };
    expect(answerLeaksSecret(Buffer.from("Bearer sk_abc123def456").toString("base64"), bearer)).toBe(true);
    expect(answerLeaksSecret(Buffer.from("sk_abc123def456").toString("base64url"), bearer)).toBe(true);
  });

  it("finds entity-escaped, Go-style JSON and \\u00XX escaped forms", () => {
    const value = `k<&>"'0123456`;
    const c = { in: "header" as const, name: "X-Key", value };
    for (const f of [
      "k&lt;&amp;&gt;&quot;&#39;0123456", "k&lt;&amp;&gt;&quot;&#x27;0123456", "k&LT;&AMP;&GT;&#34;&apos;0123456",
      'k\\u003c\\u0026\\u003e\\"\'0123456', 'k\\u003C\\u0026\\u003E\\"\'0123456', 'k<&>\\"\'0123456',
    ]) {
      expect(answerLeaksSecret(`<p>${f}</p>`, c), f).toBe(true);
      expect(redactUpstreamSecret(`a ${f} b`, value), f).toBe("a [key] b");
    }
  });

  it("redacts every form in any case, the longest first", () => {
    const value = "Bearer sk_abc123def456";
    expect(redactUpstreamSecret("sent BEARER SK_ABC123DEF456 and sk_abc123DEF456", value)).toBe("sent [key] and [key]");
    expect(redactUpstreamSecret(`echo ${Buffer.from(value).toString("base64")}.`, value)).toBe("echo [key].");
    expect(redactUpstreamSecret("price is 1 (no key here)", value)).toBe("price is 1 (no key here)");
    // Regex characters in a key are literal.
    expect(redactUpstreamSecret("x a.b*c+d?(1) y axb", "a.b*c+d?(1)")).toBe("x [key] y axb");
  });

  it("shows the last 4 characters only for long keys", () => {
    expect(upstreamSecretHint(SECRET)).toBe("cdef");
    expect(upstreamSecretHint("12345678")).toBe("");
  });
});

describe("leaks in other encodings (normalised text and base64 tokens)", () => {
  const value = "abc/def+ghi=jkl";
  const c = { in: "query" as const, name: "k", value };

  it("finds ASP.NET style \\u00XX escapes of every character, in any case", () => {
    const aspnet = [...value].map((ch) => (/[a-z0-9]/i.test(ch) ? ch : `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}`)).join("");
    expect(aspnet).toBe("abc\\u002Fdef\\u002Bghi\\u003Djkl");
    expect(answerLeaksSecret(`{"echo":"${aspnet}"}`, c)).toBe(true);
    const all = [...value].map((ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
    expect(answerLeaksSecret(`{"echo":"${all}"}`, c)).toBe(true);
  });

  it("finds decimal and hex HTML entities for every character", () => {
    const dec = [...value].map((ch) => `&#${ch.charCodeAt(0)};`).join("");
    const hex = [...value].map((ch) => `&#x${ch.charCodeAt(0).toString(16).toUpperCase()};`).join("");
    for (const f of [dec, hex, "abc&#47;def&#43;ghi&#61;jkl", "abc&#x2F;def&#x2B;ghi&#x3D;jkl", "abc&sol;def&plus;ghi&equals;jkl"]) {
      expect(answerLeaksSecret(`<p>${f}</p>`, c), f).toBe(true);
    }
  });

  it("finds mixed percent-encoding in any case, and double encoding", () => {
    for (const f of ["abc%2Fdef+ghi%3djkl", "%61bc/def%2bghi=jkl", "abc%252Fdef%252Bghi%253Djkl", "%61%62%63%2f%64%65%66%2b%67%68%69%3d%6a%6b%6c"]) {
      expect(answerLeaksSecret(`https://x/?k=${f}`, c), f).toBe(true);
    }
  });

  it("finds a key inside a base64 or base64url token of the answer", () => {
    const blob = Buffer.from(JSON.stringify({ request: { url: `https://x/?k=${value}` } })).toString("base64");
    expect(answerLeaksSecret(`{"debug":"${blob}"}`, c)).toBe(true);
    expect(answerLeaksSecret(`{"debug":"${Buffer.from(`k=${value}&x=1`).toString("base64url")}"}`, c)).toBe(true);
    expect(answerLeaksSecret(`{"debug":"${Buffer.from("nothing to see here at all").toString("base64")}"}`, c)).toBe(false);
  });

  it("finds the user or password of a Basic key, and user:pass base64 encoded", () => {
    const basic = `Basic ${Buffer.from("alice:s3cr3tpass").toString("base64")}`;
    expect(upstreamSecretParts(basic)).toEqual([basic, Buffer.from("alice:s3cr3tpass").toString("base64"), "alice:s3cr3tpass", "alice", "s3cr3tpass"]);
    const b = { in: "header" as const, name: "Authorization", value: basic };
    expect(answerLeaksSecret('{"error":"wrong password s3cr3tpass"}', b)).toBe(true);
    expect(answerLeaksSecret('{"user":"ALICE"}', b)).toBe(true);
    expect(answerLeaksSecret('{"price":1}', b)).toBe(false);
    // Short users and passwords are not looked for alone.
    expect(upstreamSecretParts(`Basic ${Buffer.from("bob:pw").toString("base64")}`)).not.toContain("bob");
  });

  it("redacts what it can locate, and withholds the whole text when the key is only found after decoding", () => {
    expect(redactUpstreamSecret("bad key abc%2Fdef%2Bghi%3Djkl here", value)).toBe("bad key [key] here");
    expect(redactUpstreamSecret("bad key abc%2Fdef+ghi%3djkl here", value)).toBe("bad key [key] here"); // form-encoded, + for the space
    expect(redactUpstreamSecret("bad key %61bc/def%2bghi=jkl here", value)).toBe(WITHHELD_TEXT);
    expect(redactUpstreamSecret("status 500 is outside 200-299", value)).toBe("status 500 is outside 200-299");
  });

  it("finds a query key whose + an upstream read as a space, and redacts that form", () => {
    expect(answerLeaksSecret('{"echo":"abc/def ghi=jkl"}', c)).toBe(true);
    expect(redactUpstreamSecret("you sent abc/def ghi=jkl", value)).toBe("you sent [key]");
  });

  it("finds the key hex encoded, lower or upper case, and redacts it", () => {
    const hex = Buffer.from(SECRET).toString("hex");
    const s = { in: "header" as const, name: "X-Key", value: SECRET };
    for (const h of [hex, hex.toUpperCase()]) {
      expect(answerLeaksSecret(`{"trace":"${h}"}`, s), h).toBe(true);
      expect(redactUpstreamSecret(`trace ${h} end`, SECRET), h).toBe("trace [key] end");
    }
  });

  it("decodes percent-encoding until the text stops changing, up to 8 rounds", () => {
    const encoded = (rounds: number) => Array.from({ length: rounds }).reduce<string>((t) => encodeURIComponent(t), value);
    for (const n of [4, 6, 8]) expect(answerLeaksSecret(`https://x/?k=${encoded(n)}`, c), String(n)).toBe(true);
    expect(redactUpstreamSecret(`k=${encoded(6)}`, value)).toBe(WITHHELD_TEXT);
  });

  it("keyAppearsIn checks several texts the same way", () => {
    expect(keyAppearsIn(value, ["GET /price?symbol=ADA", null, "GET /x?k=abc%2Fdef+ghi%3djkl"])).toBe(true);
    expect(keyAppearsIn(value, ["GET /price?symbol=ADA", '{"q":"ada"}'])).toBe(false);
    expect(keyAppearsIn(value, [])).toBe(false);
  });

  it("does not flag ordinary answers", () => {
    const s = { in: "header" as const, name: "X-Key", value: SECRET };
    for (const body of ['{"price":0.35,"symbol":"ADA"}', "symbol,price\nADA,0.35\n", "<p>&amp; &#47; %2F \\u002F</p>", Buffer.from("x".repeat(40)).toString("base64")]) {
      expect(answerLeaksSecret(body, s), body).toBe(false);
    }
  });
});
