import { describe, expect, it } from "vitest";
import { jwtExpiry, renderPreset } from "../src/authPresets";
import { UpstreamAuthError, validateUpstreamBag } from "../src/upstreamAuth";

const KEY = "sb_secret_0123456789abcdef";
const b64 = (s: string) => Buffer.from(s).toString("base64");
const jwt = (payload: object) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.c2ln`;

describe("renderPreset", () => {
  it("single: one header or query key, as today (hks2)", () => {
    expect(renderPreset("single", { in: "query", name: "api_key", value: ` ${KEY} ` }))
      .toEqual({ kind: "hks2", credential: { in: "query", name: "api_key", value: KEY } });
  });

  it("bearer: Bearer <key> in Authorization, or another word or header (hks2)", () => {
    expect(renderPreset("bearer", { key: KEY })).toEqual({ kind: "hks2", credential: { in: "header", name: "Authorization", value: `Bearer ${KEY}` } });
    expect(renderPreset("bearer", { key: KEY, scheme: "Token" })).toMatchObject({ credential: { value: `Token ${KEY}` } });
    expect(renderPreset("bearer", { key: KEY, scheme: "ApiKey", header: "X-Auth" })).toMatchObject({ credential: { name: "X-Auth", value: `ApiKey ${KEY}` } });
  });

  it("bearer: refuses a key under 8 characters, a key with spaces and an odd scheme word", () => {
    for (const f of [{ key: "abcd" }, { key: "abc1234" }, { key: `Bearer ${KEY}` }, { key: KEY, scheme: "Be arer" }, { key: KEY, header: "Host" }]) {
      expect(() => renderPreset("bearer", f), JSON.stringify(f)).toThrow(UpstreamAuthError);
    }
  });

  it("basic with an empty password: the key is the user name (hks2)", () => {
    expect(renderPreset("basic", { username: KEY })).toEqual({
      kind: "hks2", credential: { in: "header", name: "Authorization", value: `Basic ${b64(`${KEY}:`)}` },
    });
    expect(() => renderPreset("basic", { username: "short" })).toThrow(UpstreamAuthError);
  });

  it("basic with a password: a bag whose leak list is the password and the pair, never the user name (hks3)", () => {
    const r = renderPreset("basic", { username: "alice", password: "s3cr3tpass" });
    expect(r).toEqual({
      kind: "hks3", parts: [{ in: "header", name: "Authorization" }], values: [`Basic ${b64("alice:s3cr3tpass")}`], fixed: [],
      leak: ["s3cr3tpass", "alice:s3cr3tpass"],
    });
  });

  it("basic: refuses a 7-character password and a ':' in the user name", () => {
    expect(() => renderPreset("basic", { username: "alice", password: "1234567" })).toThrow(/password looks too short/);
    expect(() => renderPreset("basic", { username: "a:b", password: "s3cr3tpass" })).toThrow(UpstreamAuthError);
  });

  it("twoHeaders: the same key in apikey and Authorization: Bearer (Supabase)", () => {
    const r = renderPreset("twoHeaders", { rows: [
      { in: "header", name: "apikey", value: KEY },
      { in: "header", name: "Authorization", value: KEY, scheme: "Bearer" },
    ] });
    expect(r).toEqual({
      kind: "hks3", parts: [{ in: "header", name: "apikey" }, { in: "header", name: "Authorization" }],
      values: [KEY, `Bearer ${KEY}`], fixed: [], leak: [KEY, `Bearer ${KEY}`],
    });
    expect(() => renderPreset("twoHeaders", { rows: [{ in: "header", name: "a", value: KEY }, { in: "query", name: "b", value: KEY }] })).toThrow(UpstreamAuthError);
  });

  it("keyPlusFixed: fixed text is sent as typed and never in the leak list", () => {
    const r = renderPreset("keyPlusFixed", { rows: [
      { in: "header", name: "Authorization", value: KEY, scheme: "Bearer" },
      { in: "header", name: "Notion-Version", value: "2022-06-28", fixed: true },
    ] });
    expect(r).toEqual({
      kind: "hks3", parts: [{ in: "header", name: "Authorization" }, { in: "header", name: "Notion-Version" }],
      values: [`Bearer ${KEY}`, "2022-06-28"], fixed: [1], leak: [KEY, `Bearer ${KEY}`],
    });
    expect(() => renderPreset("keyPlusFixed", { rows: [{ in: "header", name: "a", value: KEY }, { in: "header", name: "b", value: KEY }] })).toThrow(/fixed/);
  });

  it("headerPlusQuery: a header and a query key; query names must be unique", () => {
    const r = renderPreset("headerPlusQuery", { rows: [{ in: "header", name: "X-App-Id", value: "app_12345678" }, { in: "query", name: "key", value: KEY }] });
    expect(r).toMatchObject({ kind: "hks3", parts: [{ in: "header", name: "X-App-Id" }, { in: "query", name: "key" }], leak: ["app_12345678", KEY] });
    expect(() => renderPreset("headerPlusQuery", { rows: [{ in: "query", name: "k", value: KEY }, { in: "query", name: "k", value: KEY }] })).toThrow(UpstreamAuthError);
  });

  it("rows: refuses 1 or 5 rows, a short secret, and anything the gateway would refuse", () => {
    const row = (i: number) => ({ in: "header", name: `X-K${i}`, value: KEY });
    for (const rows of [[row(0)], [0, 1, 2, 3, 4].map(row), [row(0), { ...row(1), value: "short" }], [row(0), { ...row(1), name: "Accept-Encoding" }]]) {
      expect(() => renderPreset("twoHeaders", { rows }), JSON.stringify(rows)).toThrow(UpstreamAuthError);
    }
  });

  it("rows: refuses a word-before-the-key value whose key or Basic password is under 8 characters", () => {
    const row0 = { in: "header", name: "X-K0", value: KEY };
    for (const value of ["Bearer abcd", "SSWS abc1234", `Basic ${Buffer.from("alice:short").toString("base64")}`]) {
      expect(() => renderPreset("twoHeaders", { rows: [row0, { in: "header", name: "Authorization", value }] }), value).toThrow(/too short/);
    }
    expect(renderPreset("twoHeaders", { rows: [row0, { in: "header", name: "Authorization", value: "SSWS 00abcDEF1234567890" }] })).toMatchObject({ kind: "hks3" });
  });

  it("every hks3 result passes the gateway's own bag check, and its leak list is a subset of what the gateway looks for", () => {
    const r = renderPreset("basic", { username: "alice", password: "s3cr3tpass" });
    if (r.kind !== "hks3") throw new Error("expected a bag");
    const { leakParts } = validateUpstreamBag(r.parts, r);
    for (const l of r.leak) expect(leakParts).toContain(l);
  });

  it("refuses an unknown preset and missing fields", () => {
    expect(() => renderPreset("oauth", {})).toThrow(UpstreamAuthError);
    expect(() => renderPreset("bearer", null)).toThrow(UpstreamAuthError);
    expect(() => renderPreset("twoHeaders", { rows: "x" })).toThrow(UpstreamAuthError);
  });
});

describe("jwtExpiry", () => {
  it("reads exp from a JWT alone or after Bearer", () => {
    expect(jwtExpiry(jwt({ exp: 1_800_000_000 }))?.toISOString()).toBe(new Date(1_800_000_000_000).toISOString());
    expect(jwtExpiry(`Bearer ${jwt({ exp: 1_800_000_000, sub: "x" })}`)?.getTime()).toBe(1_800_000_000_000);
  });

  it("is null for no JWT, no exp, or a payload that isn't JSON", () => {
    expect(jwtExpiry(KEY)).toBeNull();
    expect(jwtExpiry(jwt({ sub: "x" }))).toBeNull();
    expect(jwtExpiry(jwt({ exp: "soon" }))).toBeNull();
    expect(jwtExpiry(jwt({ exp: 1e300 }))).toBeNull();
    expect(jwtExpiry("eyJhbGciOiJIUzI1NiJ9.bm90IGpzb24.c2ln")).toBeNull();
  });
});
