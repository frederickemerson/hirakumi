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
});
