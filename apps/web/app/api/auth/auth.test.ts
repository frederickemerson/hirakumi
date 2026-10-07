import { beforeEach, describe, expect, it } from "vitest";
import { getSql } from "@/lib/db";
import { issueLoginChallenge } from "@/lib/session";
import { resetDb } from "@/test/db";
import { jsonRequest } from "@/test/requests";
import { makeTestWallet } from "@/test/wallet-fixture";
import { POST as logout } from "./logout/route";
import { POST as nonce } from "./nonce/route";
import { POST as verify } from "./verify/route";

async function getNonce(address: string) {
  const res = await nonce(jsonRequest("/api/auth/nonce", { body: { address } }));
  return { res, body: (await res.json()) as { address: string; message: string; nonceToken: string; error?: string } };
}

describe("wallet sign-in", () => {
  beforeEach(resetDb);

  it("signs in a seller whose wallet signs the login message", async () => {
    const w = await makeTestWallet();
    const { res, body } = await getNonce(w.addressHex);
    expect(res.status).toBe(200);
    expect(body.address).toBe(w.bech32);
    expect(body.message).toContain(w.bech32);

    const v = await verify(jsonRequest("/api/auth/verify", { body: { nonceToken: body.nonceToken, ...w.sign(body.message) } }));
    expect(v.status).toBe(200);
    expect(v.headers.get("set-cookie")).toMatch(/^hk_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax/);
    const [row] = await getSql()<{ cardanoAddr: string }[]>`select cardano_addr from sellers`;
    expect(row.cardanoAddr).toBe(w.bech32);
  });

  it("signing in twice reuses the same seller", async () => {
    const w = await makeTestWallet();
    for (let i = 0; i < 2; i++) {
      const { body } = await getNonce(w.addressHex);
      await verify(jsonRequest("/api/auth/verify", { body: { nonceToken: body.nonceToken, ...w.sign(body.message) } }));
    }
    const [{ count }] = await getSql()<{ count: number }[]>`select count(*)::int as count from sellers`;
    expect(count).toBe(1);
  });

  it("a signed sign-in works once: the same nonce and signature again is refused", async () => {
    const w = await makeTestWallet();
    const { body } = await getNonce(w.addressHex);
    const signed = { nonceToken: body.nonceToken, ...w.sign(body.message) };
    expect((await verify(jsonRequest("/api/auth/verify", { body: signed }))).status).toBe(200);
    const again = await verify(jsonRequest("/api/auth/verify", { body: signed }));
    expect(again.status).toBe(401);
    expect(((await again.json()) as { error: string }).error).toBe("This sign-in link was already used. Start again.");
    expect(again.headers.get("set-cookie")).toBeNull();
  });

  it("20 concurrent verifies of one signed sign-in open exactly one session", async () => {
    const w = await makeTestWallet();
    const { body } = await getNonce(w.addressHex);
    const signed = { nonceToken: body.nonceToken, ...w.sign(body.message) };
    const res = await Promise.all(Array.from({ length: 20 }, () => verify(jsonRequest("/api/auth/verify", { body: signed }))));
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    expect(res.filter((r) => r.status === 401)).toHaveLength(19);
    expect(res.filter((r) => r.headers.get("set-cookie"))).toHaveLength(1);
  });

  it("a wrong signature does not use up the nonce", async () => {
    const owner = await makeTestWallet();
    const attacker = await makeTestWallet();
    const { body } = await getNonce(owner.addressHex);
    const bad = await verify(jsonRequest("/api/auth/verify", { body: { nonceToken: body.nonceToken, ...attacker.sign(body.message) } }));
    expect(bad.status).toBe(401);
    const good = await verify(jsonRequest("/api/auth/verify", { body: { nonceToken: body.nonceToken, ...owner.sign(body.message) } }));
    expect(good.status).toBe(200);
  });

  it("rejects a signature from a different wallet", async () => {
    const owner = await makeTestWallet();
    const attacker = await makeTestWallet();
    const { body } = await getNonce(owner.addressHex);
    const v = await verify(jsonRequest("/api/auth/verify", { body: { nonceToken: body.nonceToken, ...attacker.sign(body.message) } }));
    expect(v.status).toBe(401);
    expect(((await v.json()) as { error: string }).error).toMatch(/signature didn't match/);
    expect(v.headers.get("set-cookie")).toBeNull();
  });

  it("rejects mainnet wallets in plain English", async () => {
    const w = await makeTestWallet(1);
    const { res, body } = await getNonce(w.addressHex);
    expect(res.status).toBe(400);
    expect(body.error).toBe("Switch your wallet to the Cardano preprod test network, then try again.");
  });

  it("rejects an expired sign-in request", async () => {
    const w = await makeTestWallet();
    const old = issueLoginChallenge(w.bech32, Math.floor(Date.now() / 1000) - 600);
    const v = await verify(jsonRequest("/api/auth/verify", { body: { nonceToken: old.nonceToken, ...w.sign(old.message) } }));
    expect(v.status).toBe(401);
    expect(((await v.json()) as { error: string }).error).toBe("This sign-in request expired. Start again.");
  });

  it("logs out by clearing the cookie and redirecting", async () => {
    const res = await logout(new Request("https://web.hirakumi.test/api/auth/logout", { method: "POST" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("logs out from a same-origin form post, but refuses a cross-site one", async () => {
    const at = (headers: Record<string, string>) =>
      logout(new Request("https://web.hirakumi.test/api/auth/logout", { method: "POST", headers }));
    expect((await at({ "sec-fetch-site": "same-origin", origin: "https://web.hirakumi.test" })).status).toBe(303);
    const res = await at({ "sec-fetch-site": "cross-site", origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
