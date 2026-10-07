import { describe, expect, it } from "vitest";
import { buildUpstreamRequest, HOP_HEADER, resolveAuth } from "../src/upstreamRequest";
import { validateUpstreamAuth } from "../src/upstreamAuth";

const api = { origin: "https://api.example.com", path_prefix: "/v1" };
const op = { method: "GET", path: "/price" };
const KEY = "sb_secret_0123456789abcdef";

describe("buildUpstreamRequest and the key (audit 1a)", () => {
  it("a keyless call (the leak check) sends no key and doesn't ask for an uncompressed answer, but keeps the hop header", () => {
    const r = buildUpstreamRequest(api, op, { symbol: "ADA" });
    expect(Object.keys(r.init.headers).sort()).toEqual(["accept", "user-agent", HOP_HEADER].sort());
    expect(r.init.headers[HOP_HEADER]).toBe("1");
    expect(r.url).toBe("https://api.example.com/v1/price?symbol=ADA");
  });

  it("a single key is sent as before, with accept-encoding: identity and the hop header", () => {
    const credential = validateUpstreamAuth({ in: "header", name: "X-API-Key", value: KEY });
    const r = buildUpstreamRequest({ ...api, credential }, op, {});
    expect(r.init.headers).toMatchObject({ "x-api-key": KEY, "accept-encoding": "identity", [HOP_HEADER]: "1" });
  });

  it("a bag (hks3, credential null) sends every part, last, so no buyer field replaces one", () => {
    const auth = {
      parts: [{ in: "header" as const, name: "apikey", value: KEY }, { in: "header" as const, name: "Authorization", value: `Bearer ${KEY}` },
        { in: "query" as const, name: "project", value: "proj_12345678" }],
      leakParts: [KEY],
    };
    const r = buildUpstreamRequest({ ...api, credential: null, auth }, op, { project: "buyer_value", symbol: "ADA" });
    expect(r.init.headers).toMatchObject({ apikey: KEY, authorization: `Bearer ${KEY}`, "accept-encoding": "identity", [HOP_HEADER]: "1" });
    expect(new URL(r.url).searchParams.getAll("project")).toEqual(["proj_12345678"]);
    expect(new URL(r.url).searchParams.get("symbol")).toBe("ADA");
  });

  it("resolveAuth reads a bag before a credential, and a credential as its parts and leak set", () => {
    const credential = validateUpstreamAuth({ in: "header", name: "Authorization", value: `Bearer ${KEY}` });
    expect(resolveAuth({ credential })).toEqual({ parts: [credential], leakParts: [`Bearer ${KEY}`, KEY] });
    expect(resolveAuth({ credential: null })).toBeNull();
    const auth = { parts: [credential], leakParts: ["x".repeat(8)] };
    expect(resolveAuth({ credential: null, auth })).toBe(auth);
  });

  it("refuses a key that can't be opened before anything else is built", () => {
    expect(() => buildUpstreamRequest({ ...api, credentialError: "no key" }, op, {})).toThrow(/blocked: no key/);
  });
});
