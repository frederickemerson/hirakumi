import { describe, expect, it } from "vitest";
import {
  AMBIGUOUS_PATH,
  firstServerUrl,
  matchVerifyHeader,
  newVerifyCode,
  ownershipCheckUrl,
  unsafePathReason,
  urlCarriesCode,
  verifyCodesEqual,
} from "../src/ownership";

const CODE = "hkv_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER = "hkv_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

describe("verify code", () => {
  it("is unguessable (>= 128 bits of randomness) and never repeats", () => {
    const codes = new Set(Array.from({ length: 200 }, () => newVerifyCode()));
    expect(codes.size).toBe(200);
    for (const c of codes) {
      expect(c).toMatch(/^hkv_[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url
    }
  });
  it("compares exactly", () => {
    expect(verifyCodesEqual(CODE, CODE)).toBe(true);
    expect(verifyCodesEqual(CODE, OTHER)).toBe(false);
    expect(verifyCodesEqual(CODE, `${CODE} `)).toBe(false);
    expect(verifyCodesEqual(CODE, CODE.slice(0, -1))).toBe(false);
    expect(verifyCodesEqual(CODE, "")).toBe(false);
  });
});

describe("matchVerifyHeader", () => {
  it("matches the exact code, trimmed", () => {
    expect(matchVerifyHeader(CODE, CODE)).toBe("match");
    expect(matchVerifyHeader(`  ${CODE}\t`, CODE)).toBe("match");
  });
  it("matches when any one of several values is the code, comma-joined or repeated", () => {
    expect(matchVerifyHeader(`${OTHER}, ${CODE}`, CODE)).toBe("match");
    expect(matchVerifyHeader([OTHER, CODE], CODE)).toBe("match");
    expect(matchVerifyHeader([`${OTHER},x`, ` ${CODE} `], CODE)).toBe("match");
  });
  it("is missing when the header is absent", () => {
    expect(matchVerifyHeader(undefined, CODE)).toBe("missing");
    expect(matchVerifyHeader(null, CODE)).toBe("missing");
  });
  it("is a mismatch when present with another value, another API's code, a prefix or a different case", () => {
    for (const v of ["", "hkv_wrong", OTHER, CODE.slice(0, -1), `${CODE}x`, CODE.toLowerCase(), `${OTHER},${OTHER}`, []]) {
      expect(matchVerifyHeader(v as string | string[], CODE), String(v)).toBe("mismatch");
    }
  });
});

describe("ownershipCheckUrl", () => {
  const code = "hkv_Ab3dEf7hIj9kLm1nOp5qRs2tUv4wXy6zAb8cDe0fGh2";
  const url = (origin: string, pathPrefix: string) => ownershipCheckUrl({ origin, pathPrefix, code });

  it("is origin + path_prefix, with / and an empty prefix meaning the root", () => {
    expect(url("https://h.com", "/")).toEqual({ ok: true, url: "https://h.com/" });
    expect(url("https://h.com", "")).toEqual({ ok: true, url: "https://h.com/" });
    expect(url("https://h.com/", "/v1")).toEqual({ ok: true, url: "https://h.com/v1" });
    expect(url("https://h.com:8443", "/team-a/v2/")).toEqual({ ok: true, url: "https://h.com:8443/team-a/v2/" });
  });
  it("never has a query or fragment", () => {
    for (const p of ["/v1?x=1", "/v1?", "/v1#x", "/?a"]) expect(url("https://h.com", p), p).toMatchObject({ ok: false });
    for (const o of ["https://h.com?x=1", "https://h.com/#x", "https://h.com/path", "https://u:p@h.com", "not a url"]) {
      expect(url(o, "/"), o).toMatchObject({ ok: false });
    }
  });
  it("refuses paths a server could read as another folder", () => {
    for (const p of ["/a%2Fb", "/a%2fb", "/a%5cb", "/a%2e%2e/b", "/a;b", "/a\\b", "/a/../b", "/a/./b", "//b", "/a//b", "v1"]) {
      expect(url("https://h.com", p), p).toMatchObject({ ok: false });
    }
    expect(AMBIGUOUS_PATH.test("/a%2Fb")).toBe(true);
  });
  it("refuses a double-encoded, control or non-ASCII base path a server could decode into another folder", () => {
    for (const p of [
      "/%252e%252e/", "/a/%252e%252e/b", "/a%25", "/%252f", "/v1/%25", "/%c0%ae%c0%ae/", "/%C0%AE", "/．．/", "/a/．/b", "/ａpi",
      "/a%00", "/a%09b", "/a%7f", "/a\tb", "/a\u0000b", "/caf%C3%A9",
    ]) {
      expect(url("https://h.com", p), JSON.stringify(p)).toMatchObject({ ok: false });
      expect(unsafePathReason(p), JSON.stringify(p)).not.toBeNull();
    }
    for (const p of ["/a%20b", "/v1/%7Euser", "/team-a_b.c~d/v2"]) expect(url("https://h.com", p), p).toMatchObject({ ok: true });
  });
  it("names why an endpoint path is refused", () => {
    expect(unsafePathReason("/a/%252e%252e/b")).toBe("its path has an encoded percent sign (%25)");
    expect(unsafePathReason("/a%09b")).toBe("its path has a control character");
    expect(unsafePathReason("/．．/x")).toBe("its path has a character outside plain ASCII");
    expect(unsafePathReason("/%c0%ae%c0%ae/x")).toBe("its path has a character outside plain ASCII");
    expect(unsafePathReason("/prices/{symbol}")).toBeNull();
  });
  it("refuses a URL that carries the code, or a run of it, in any form", () => {
    const secret = code.slice(4);
    for (const p of [
      `/${code}`, `/response-headers/X-Hirakumi-Verify/${code}`, `/x/${secret.slice(5, 17)}`, `/${encodeURIComponent(code)}`,
      `/${secret.slice(0, 12).toUpperCase()}`, `/${secret.slice(0, 12).split("").join("-")}`,
      `/${secret.slice(0, 12).split("").map((c) => `%${c.charCodeAt(0).toString(16)}`).join("")}`,
    ]) {
      const r = url("https://h.com", p);
      expect(r, p).toMatchObject({ ok: false });
      if (!r.ok) expect(r.detail).toMatch(/contains the verification code/);
    }
    expect(url(`https://${secret.slice(10, 22)}.example.com`, "/")).toMatchObject({ ok: false }); // in the host too
    expect(urlCarriesCode(`https://h.com/${code}`, code)).toBe(true);
    expect(urlCarriesCode("https://h.com/v1", code)).toBe(false);
    expect(urlCarriesCode(`https://h.com/${secret.slice(0, 9)}`, code)).toBe(false); // shorter than a run
    expect(urlCarriesCode("https://h.com/hkv_", code)).toBe(false); // the prefix alone is not the code
  });
});

describe("firstServerUrl", () => {
  it("fills server variables from their defaults", () => {
    expect(firstServerUrl([{ url: "https://{host}/v1", variables: { host: { default: "h.com" } } }])).toBe("https://h.com/v1");
    expect(firstServerUrl(undefined)).toBeNull();
    expect(firstServerUrl([{ url: "  " }])).toBeNull();
  });
});
