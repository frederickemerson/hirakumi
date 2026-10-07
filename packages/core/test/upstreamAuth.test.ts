import { describe, expect, it } from "vitest";
import {
  answerLeaksSecret, generateUpstreamAuthKeys, openUpstreamSecret, redactUpstreamSecret, sealUpstreamSecret, textLeaksSecret, UpstreamAuthError,
  upstreamSecretHint, upstreamSecretParts, validateUpstreamAuth,
} from "../src/upstreamAuth";

const keys = generateUpstreamAuthKeys();
const SECRET = "sk_live_0123456789abcdef";

describe("sealed upstream keys", () => {
  it("round-trips for the same API, and every seal is different", () => {
    const a = sealUpstreamSecret(keys.publicKey, "api_1", SECRET);
    const b = sealUpstreamSecret(keys.publicKey, "api_1", SECRET);
    expect(a).not.toBe(b);
    expect(a).not.toContain(SECRET);
    expect(openUpstreamSecret(keys.privateKey, "api_1", a)).toBe(SECRET);
  });

  it("does not open for another API, another private key, or after tampering", () => {
    const sealed = sealUpstreamSecret(keys.publicKey, "api_1", SECRET);
    expect(() => openUpstreamSecret(keys.privateKey, "api_2", sealed)).toThrow(UpstreamAuthError);
    expect(() => openUpstreamSecret(generateUpstreamAuthKeys().privateKey, "api_1", sealed)).toThrow(UpstreamAuthError);
    const parts = sealed.split(".");
    const ct = Buffer.from(parts[3], "base64url");
    ct[0] ^= 1;
    parts[3] = ct.toString("base64url");
    expect(() => openUpstreamSecret(keys.privateKey, "api_1", parts.join("."))).toThrow(UpstreamAuthError);
    expect(() => openUpstreamSecret(keys.privateKey, "api_1", "nope")).toThrow(UpstreamAuthError);
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
