import { afterEach, describe, expect, it } from "vitest";
import { matchOperation, normalizeHost, pathAfterPrefix } from "../src/routeMatch";

describe("normalizeHost", () => {
  it.each([
    ["api.seller.com", "api.seller.com"],
    ["API.Seller.COM", "api.seller.com"],
    ["api.seller.com:443", "api.seller.com"],
    ["api.seller.com.", "api.seller.com"],
    ["api.seller.com.:8443", "api.seller.com"],
    ["  gateway  ", "gateway"],
    ["localhost:4021", "localhost"],
  ])("%s -> %s", (raw, want) => { expect(normalizeHost(raw)).toBe(want); });

  it.each([
    [undefined], [""], ["127.0.0.1"], ["127.0.0.1:4021"], ["52.70.235.103"], ["[::1]"], ["[::1]:443"], ["::1"],
    ["1.2.3"], ["010.1.1.1"], ["a b.com"], ["a/b.com"], ["evil.com@x.com"], ["x.com:99999x"], ["-bad.com"], ["a..b.com"],
  ])("refuses %s", (raw) => { expect(normalizeHost(raw)).toBeNull(); });
});

describe("pathAfterPrefix", () => {
  it("strips the prefix only at a segment boundary", () => {
    expect(pathAfterPrefix("/v1", "/v1/price")).toBe("/price");
    expect(pathAfterPrefix("/v1/", "/v1/price")).toBe("/price");
    expect(pathAfterPrefix("/v1", "/v1")).toBe("/");
    expect(pathAfterPrefix("/v1", "/v10/price")).toBeNull();
    expect(pathAfterPrefix("/v1", "/other")).toBeNull();
    expect(pathAfterPrefix("/", "/price")).toBe("/price");
    expect(pathAfterPrefix("", "/price")).toBe("/price");
  });
});

describe("matchOperation", () => {
  const ops = [
    { id: "get", method: "GET", path: "/items/{id}" },
    { id: "latest", method: "GET", path: "/items/latest" },
    { id: "put", method: "PUT", path: "/items/{id}" },
    { id: "file", method: "GET", path: "/files/{name}.json" },
    { id: "nested", method: "GET", path: "/a/{x}/b/{y}" },
    { id: "root", method: "GET", path: "/" },
    { id: "price", method: "get", path: "/price" },
  ];
  const m = (method: string, path: string) => matchOperation(ops, method, path);

  it("matches templates and fills path parameters", () => {
    expect(m("GET", "/items/42")).toEqual({ kind: "match", op: ops[0], params: { id: "42" } });
    expect(m("PUT", "/items/42")).toEqual({ kind: "match", op: ops[2], params: { id: "42" } });
    expect(m("GET", "/a/1/b/2")).toMatchObject({ kind: "match", params: { x: "1", y: "2" } });
    expect(m("GET", "/files/report.json")).toMatchObject({ kind: "match", op: ops[3], params: { name: "report" } });
    expect(m("GET", "/")).toMatchObject({ kind: "match", op: ops[5] });
    expect(m("get", "/price")).toMatchObject({ kind: "match", op: ops[6] });
  });

  it("prefers literal segments over parameters", () => {
    expect(m("GET", "/items/latest")).toMatchObject({ kind: "match", op: ops[1], params: {} });
  });

  it("decodes each segment once", () => {
    expect(m("GET", "/items/a%20b")).toMatchObject({ params: { id: "a b" } });
    expect(m("GET", "/items/%2541")).toMatchObject({ params: { id: "%41" } });
  });

  it("refuses segments that could step outside the folder", () => {
    for (const p of ["/items/..", "/items/.", "/items/%2e%2e", "/items/a%2Fb", "/items/a%5Cb", "/items//", "/items/%E0%A4%A"]) {
      expect(m("GET", p).kind).toBe("bad_path");
    }
  });

  it("says which methods would match", () => {
    expect(m("DELETE", "/items/1")).toEqual({ kind: "method_not_allowed", allow: ["GET", "PUT"] });
    expect(m("POST", "/price")).toEqual({ kind: "method_not_allowed", allow: ["GET"] });
  });

  it("is not_found for other paths", () => {
    expect(m("GET", "/items")).toEqual({ kind: "not_found" });
    expect(m("GET", "/items/1/2")).toEqual({ kind: "not_found" });
    expect(m("GET", "/files/report.xml")).toEqual({ kind: "not_found" });
    expect(m("GET", "/price/")).toEqual({ kind: "bad_path", reason: expect.any(String) });
  });
});

