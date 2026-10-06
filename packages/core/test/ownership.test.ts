import { describe, expect, it } from "vitest";
import {
  checkSpecBinding,
  firstServerUrl,
  newVerifyCode,
  readSpec,
  specDirectory,
  verifyCodesEqual,
  verifySpecField,
  VERIFY_FIELD,
} from "../src/ownership";

const CODE = "hkv_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER = "hkv_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

const jsonSpec = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ openapi: "3.1.0", info: { title: "t", version: "1" }, servers: [{ url: "https://h.com" }], paths: {}, ...extra });

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

describe("verifySpecField", () => {
  it("matches the root field in JSON", () => {
    expect(verifySpecField(jsonSpec({ [VERIFY_FIELD]: CODE }), CODE)).toEqual({ kind: "match" });
  });
  it("matches the root field in YAML (quoted or plain)", () => {
    const yaml = (v: string) => `openapi: 3.1.0\ninfo:\n  title: t\n  version: "1"\n${VERIFY_FIELD}: ${v}\npaths: {}\n`;
    expect(verifySpecField(yaml(`"${CODE}"`), CODE)).toEqual({ kind: "match" });
    expect(verifySpecField(yaml(CODE), CODE)).toEqual({ kind: "match" });
  });
  it("reports a missing field", () => {
    expect(verifySpecField(jsonSpec(), CODE)).toEqual({ kind: "missing" });
  });
  it("only reads the root: a nested field does not count", () => {
    expect(verifySpecField(jsonSpec({ info: { title: "t", version: "1", [VERIFY_FIELD]: CODE } }), CODE)).toEqual({ kind: "missing" });
  });
  it("reports a wrong code", () => {
    expect(verifySpecField(jsonSpec({ [VERIFY_FIELD]: "hkv_wrong" }), CODE)).toEqual({ kind: "mismatch" });
  });
  it("fails with another API's code", () => {
    expect(verifySpecField(jsonSpec({ [VERIFY_FIELD]: OTHER }), CODE)).toEqual({ kind: "mismatch" });
  });
  it("does not accept a non-string value or a list of codes", () => {
    expect(verifySpecField(jsonSpec({ [VERIFY_FIELD]: [CODE] }), CODE)).toEqual({ kind: "mismatch" });
    expect(verifySpecField(jsonSpec({ [VERIFY_FIELD]: 42 }), CODE)).toEqual({ kind: "mismatch" });
  });
  it("reports a file it cannot read", () => {
    expect(verifySpecField("<html>not a spec</html>", CODE)).toEqual({ kind: "unreadable" });
    expect(verifySpecField("[1, 2]", CODE)).toEqual({ kind: "unreadable" });
    expect(verifySpecField("a: [unclosed", CODE)).toEqual({ kind: "unreadable" });
  });
  it("readSpec handles both formats", () => {
    expect(readSpec('{"a":1}')).toEqual({ a: 1 });
    expect(readSpec("a: 1\n")).toEqual({ a: 1 });
    expect(readSpec("")).toBeNull();
  });
});

describe("firstServerUrl", () => {
  it("fills server variables from their defaults", () => {
    expect(firstServerUrl([{ url: "https://{host}/v1", variables: { host: { default: "h.com" } } }])).toBe("https://h.com/v1");
    expect(firstServerUrl(undefined)).toBeNull();
    expect(firstServerUrl([{ url: "  " }])).toBeNull();
  });
});

describe("specDirectory", () => {
  it("is the path up to the last slash", () => {
    expect(specDirectory(new URL("https://h.com/openapi.json"))).toBe("/");
    expect(specDirectory(new URL("https://h.com/team-a/openapi.json"))).toBe("/team-a/");
    expect(specDirectory(new URL("https://h.com/team-a/spec/"))).toBe("/team-a/spec/");
    expect(specDirectory(new URL("https://h.com/team-a/openapi.json?v=2"))).toBe("/team-a/");
  });
});

describe("checkSpecBinding", () => {
  const base = { origin: "https://h.com" };

  it("a spec at the root covers any base path", () => {
    for (const pathPrefix of ["/", "/v1", "/team-a/v2"]) {
      expect(checkSpecBinding({ ...base, openapiUrl: "https://h.com/openapi.json", pathPrefix })).toEqual({ ok: true });
    }
  });
  it("a spec in a directory covers bases at or under that directory", () => {
    const openapiUrl = "https://h.com/team-a/openapi.json";
    expect(checkSpecBinding({ ...base, openapiUrl, pathPrefix: "/team-a" })).toEqual({ ok: true });
    expect(checkSpecBinding({ ...base, openapiUrl, pathPrefix: "/team-a/v1" })).toEqual({ ok: true });
  });
  it("a spec in a directory does not cover the root, a sibling or a look-alike", () => {
    const openapiUrl = "https://h.com/team-a/openapi.json";
    for (const pathPrefix of ["/", "/team-b", "/team-ab", "/team-b/team-a"]) {
      const r = checkSpecBinding({ ...base, openapiUrl, pathPrefix });
      expect(r).toMatchObject({ ok: false, reason: "outside_directory" });
    }
  });
  it("checks the spec's current servers[0] too", () => {
    const openapiUrl = "https://h.com/team-a/openapi.json";
    expect(checkSpecBinding({ ...base, openapiUrl, pathPrefix: "/team-a", serverUrl: "https://h.com/team-a/v1" })).toEqual({ ok: true });
    expect(checkSpecBinding({ ...base, openapiUrl, pathPrefix: "/team-a", serverUrl: "v1" })).toEqual({ ok: true });
    expect(checkSpecBinding({ ...base, openapiUrl, pathPrefix: "/team-a", serverUrl: "https://h.com/team-b" }))
      .toMatchObject({ ok: false, reason: "outside_directory" });
    expect(checkSpecBinding({ ...base, openapiUrl, pathPrefix: "/team-a", serverUrl: "/" }))
      .toMatchObject({ ok: false, reason: "outside_directory" });
  });
  it("refuses a spec on another origin than the API", () => {
    expect(checkSpecBinding({ ...base, openapiUrl: "https://evil.com/openapi.json", pathPrefix: "/" }))
      .toMatchObject({ ok: false, reason: "origin_mismatch" });
    expect(checkSpecBinding({ ...base, openapiUrl: "https://h.com:8443/openapi.json", pathPrefix: "/" }))
      .toMatchObject({ ok: false, reason: "origin_mismatch" });
    expect(checkSpecBinding({ ...base, openapiUrl: "http://h.com/openapi.json", pathPrefix: "/" }))
      .toMatchObject({ ok: false, reason: "origin_mismatch" });
  });
  it("refuses a servers[0] on another origin than the API", () => {
    expect(checkSpecBinding({ ...base, openapiUrl: "https://h.com/openapi.json", pathPrefix: "/", serverUrl: "https://victim.com" }))
      .toMatchObject({ ok: false, reason: "origin_mismatch" });
  });
  it("refuses encoded separators and path parameters that a server could read differently", () => {
    for (const openapiUrl of [
      "https://h.com/team-a/..%2Fteam-b/openapi.json",
      "https://h.com/team-a%2F..%2Fteam-b/openapi.json",
      "https://h.com/team-a/a%2eb/openapi.json",
      "https://h.com/team-a;x/openapi.json",
    ]) {
      expect(checkSpecBinding({ ...base, openapiUrl, pathPrefix: "/team-a" })).toMatchObject({ ok: false, reason: "bad_url" });
    }
    expect(checkSpecBinding({ ...base, openapiUrl: "https://h.com/openapi.json", pathPrefix: "/a%2Fb" }))
      .toMatchObject({ ok: false, reason: "bad_url" });
  });
  it("normalises dot segments before comparing", () => {
    expect(checkSpecBinding({ ...base, openapiUrl: "https://h.com/team-a/../team-b/openapi.json", pathPrefix: "/team-a" }))
      .toMatchObject({ ok: false, reason: "outside_directory" });
    // Encoded dots are dot segments too (the fetch goes to /openapi.json), so this spec covers the root.
    expect(checkSpecBinding({ ...base, openapiUrl: "https://h.com/team-b/%2e%2e/openapi.json", pathPrefix: "/team-a" })).toEqual({ ok: true });
  });
});
