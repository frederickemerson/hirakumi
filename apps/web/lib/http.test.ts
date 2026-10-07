import { describe, expect, it } from "vitest";
import { readJson, requireSeller, sameOrigin } from "./http";

const req = (contentType: string, body = '{"a":1}') => new Request("http://web.test/x", { method: "POST", headers: { "content-type": contentType }, body });

describe("readJson", () => {
  it("accepts application/json, with or without parameters", async () => {
    expect(await readJson(req("application/json"))).toEqual({ a: 1 });
    expect(await readJson(req("Application/JSON; charset=utf-8"))).toEqual({ a: 1 });
  });
  it("refuses any other media type, even one that mentions application/json (CSRF: simple form posts)", async () => {
    expect(await readJson(req("text/plain; application/json"))).toBeNull();
    expect(await readJson(req("text/plain"))).toBeNull();
    expect(await readJson(req("application/x-www-form-urlencoded"))).toBeNull();
  });
});

describe("sameOrigin (CSRF guard for body-less state changes)", () => {
  const at = (method: string, headers: Record<string, string> = {}) =>
    new Request("https://web.hirakumi.test/api/apis/x/retire", { method, headers });

  it("always allows safe methods", () => {
    expect(sameOrigin(at("GET", { "sec-fetch-site": "cross-site", origin: "https://evil.example" }))).toBe(true);
    expect(sameOrigin(at("HEAD", { "sec-fetch-site": "cross-site" }))).toBe(true);
  });
  it("trusts Sec-Fetch-Site when present: only same-origin or none pass", () => {
    expect(sameOrigin(at("POST", { "sec-fetch-site": "same-origin", origin: "https://web.hirakumi.test" }))).toBe(true);
    expect(sameOrigin(at("POST", { "sec-fetch-site": "none" }))).toBe(true);
    expect(sameOrigin(at("POST", { "sec-fetch-site": "same-site" }))).toBe(false);
    expect(sameOrigin(at("POST", { "sec-fetch-site": "cross-site", origin: "https://web.hirakumi.test" }))).toBe(false);
  });
  it("otherwise requires Origin to match WEB_BASE_URL", () => {
    expect(sameOrigin(at("POST", { origin: "https://web.hirakumi.test" }))).toBe(true);
    expect(sameOrigin(at("DELETE", { origin: "https://evil.example" }))).toBe(false);
    expect(sameOrigin(at("POST", { origin: "http://web.hirakumi.test" }))).toBe(false);
    expect(sameOrigin(at("POST", { origin: "null" }))).toBe(false);
  });
  it("allows requests with neither header (non-browser clients)", () => {
    expect(sameOrigin(at("POST"))).toBe(true);
  });
  it("requireSeller refuses a cross-site request with 403 before looking at the session", async () => {
    const res = await requireSeller(at("POST", { "sec-fetch-site": "cross-site" }));
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(403);
  });
});
