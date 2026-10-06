import { describe, it, expect } from "vitest";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenStore } from "../src/tokenStore.js";

const rec = { token: "hk_x", packId: "pk_1", credits: 100, txHash: null, boughtAt: "2026-10-06T08:00:00.000Z" };

describe("TokenStore", () => {
  it("returns undefined when the file does not exist", () => {
    const s = new TokenStore(join(mkdtempSync(join(tmpdir(), "hk-")), "t.json"));
    expect(s.get("api_1")).toBeUndefined();
  });

  it("round-trips and keeps the file private (0600)", () => {
    const path = join(mkdtempSync(join(tmpdir(), "hk-")), "nested", "t.json");
    const s = new TokenStore(path);
    s.put("api_1", rec);
    expect(new TokenStore(path).get("api_1")).toEqual(rec);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("deletes one api without touching others", () => {
    const s = new TokenStore(join(mkdtempSync(join(tmpdir(), "hk-")), "t.json"));
    s.put("api_1", rec);
    s.put("api_2", { ...rec, token: "hk_y" });
    s.delete("api_1");
    expect(s.get("api_1")).toBeUndefined();
    expect(s.get("api_2")?.token).toBe("hk_y");
  });
});
