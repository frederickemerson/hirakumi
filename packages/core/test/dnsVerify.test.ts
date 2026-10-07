import { describe, expect, it } from "vitest";
import { isNoRecordError, matchVerifyTxt, verifyRecordFor } from "../src/dnsVerify";

const CODE = "hkv_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER = "hkv_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

describe("verifyRecordFor", () => {
  it("is _hirakumi. + the hostname, lowercase, without port, path or trailing dot", () => {
    expect(verifyRecordFor("https://API.Example.com:8443")).toEqual({ ok: true, host: "api.example.com", name: "_hirakumi.api.example.com" });
    expect(verifyRecordFor("https://example.com.")).toMatchObject({ ok: true, name: "_hirakumi.example.com" });
  });
  it("uses the punycode form of an international name", () => {
    expect(verifyRecordFor("https://bücher.example")).toMatchObject({ ok: true, name: "_hirakumi.xn--bcher-kva.example" });
  });
  it.each(["https://52.70.235.103", "http://[2001:db8::1]:8080", "http://localhost:3000", "nope"])("refuses %s: no DNS of its own", (origin) => {
    expect(verifyRecordFor(origin).ok).toBe(false);
  });
});

describe("matchVerifyTxt", () => {
  it("matches one record among several, with chunks joined", () => {
    expect(matchVerifyTxt([["v=spf1 -all"], [CODE.slice(0, 20), CODE.slice(20)]], CODE)).toBe("match");
  });
  it("tolerates spaces and one pair of quotes pasted into the value", () => {
    expect(matchVerifyTxt([[` "${CODE}" `]], CODE)).toBe("match");
  });
  it("is missing with no records, and a mismatch when none has this code", () => {
    expect(matchVerifyTxt([], CODE)).toBe("missing");
    expect(matchVerifyTxt([[OTHER]], CODE)).toBe("mismatch");
    expect(matchVerifyTxt([[`${CODE}x`]], CODE)).toBe("mismatch");
  });
});

describe("isNoRecordError", () => {
  it("is true for no data and no such name, false for timeouts and server failures", () => {
    expect(isNoRecordError(Object.assign(new Error("x"), { code: "ENODATA" }))).toBe(true);
    expect(isNoRecordError(Object.assign(new Error("x"), { code: "ENOTFOUND" }))).toBe(true);
    expect(isNoRecordError(Object.assign(new Error("x"), { code: "ETIMEOUT" }))).toBe(false);
    expect(isNoRecordError(Object.assign(new Error("x"), { code: "ESERVFAIL" }))).toBe(false);
    expect(isNoRecordError(null)).toBe(false);
  });
});
