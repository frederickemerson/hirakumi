import { describe, expect, it } from "vitest";
import { readJson } from "./http";

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
