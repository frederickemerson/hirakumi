import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { newBearerToken, newId, sha256Hex } from "../src/ids";

describe("ids", () => {
  it("newId is prefix + '_' + 10 lowercase base32 chars and unique", () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newId("api")));
    expect(ids.size).toBe(2000);
    for (const id of ids) expect(id).toMatch(/^api_[a-z2-7]{10}$/);
    expect(newId("ct")).toMatch(/^ct_[a-z2-7]{10}$/);
  });
  it("newBearerToken is hk_ + 43 base64url chars (32 bytes)", () => {
    const t = newBearerToken();
    expect(t).toMatch(/^hk_[A-Za-z0-9_-]{43}$/);
    expect(newBearerToken()).not.toBe(t);
  });
  it("sha256Hex hashes UTF-8", () => {
    expect(sha256Hex("héllo")).toBe(createHash("sha256").update("héllo", "utf8").digest("hex"));
  });
});
