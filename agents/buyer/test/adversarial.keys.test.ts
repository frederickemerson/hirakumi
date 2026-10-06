// Key and token handling: secrets must never be logged or land in a group/world-readable file.
import { describe, expect, it } from "vitest";
import { statSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { IouKeyStore } from "../src/escrowPack.js";
import { runEscrowPack } from "../src/escrowPackFlow.js";
import { PendingStore, TokenStore } from "../src/tokenStore.js";
import { BUYER, flowOpts, maliciousEscrowGateway, offer, tmpDir } from "./adversarial.helpers.js";
import { json } from "./fakeGateway.js";

const mode = (p: string) => statSync(p).mode & 0o777;

describe("file permissions", () => {
  it("token store: fresh file is 0600", () => {
    const p = join(tmpDir(), ".tokens.json");
    new TokenStore(p).put("api_demo", { token: "hk_secret", packId: "pk", credits: 1, txHash: null, boughtAt: "x" });
    expect(mode(p)).toBe(0o600);
  });

  it("token store: a leftover world-readable .tmp (e.g. from a crash or another user) must not make the bearer token world-readable", () => {
    const p = join(tmpDir(), ".tokens.json");
    writeFileSync(`${p}.tmp`, "{}");
    chmodSync(`${p}.tmp`, 0o644);
    new TokenStore(p).put("api_demo", { token: "hk_secret", packId: "pk", credits: 1, txHash: null, boughtAt: "x" });
    expect(mode(p)).toBe(0o600);
  });

  it("pending-payment store (signed payment + recovery secret): same leftover .tmp case", () => {
    const p = join(tmpDir(), ".pending-payments.json");
    writeFileSync(`${p}.tmp`, "{}");
    chmodSync(`${p}.tmp`, 0o644);
    new PendingStore(p).put("api_demo", { packId: "pk", paymentSignature: "sig", recoverySecret: "secret", at: "x" });
    expect(mode(p)).toBe(0o600);
  });

  it("token store: an existing 0644 token file is tightened on the next write", () => {
    const p = join(tmpDir(), ".tokens.json");
    writeFileSync(p, "{}");
    chmodSync(p, 0o644);
    new TokenStore(p).put("api_demo", { token: "hk_secret", packId: "pk", credits: 1, txHash: null, boughtAt: "x" });
    expect(mode(p)).toBe(0o600);
  });

  it("IOU key store: leftover 0644 .tmp and existing 0644 file both end up 0600", () => {
    const p = join(tmpDir(), ".escrow-keys.json");
    writeFileSync(`${p}.tmp`, "{}");
    chmodSync(`${p}.tmp`, 0o644);
    new IouKeyStore(p).ensure("api_demo", "pk", BUYER, new Date());
    expect(mode(p)).toBe(0o600);
    chmodSync(p, 0o644);
    new IouKeyStore(p).ensure("api_demo", "pk2", BUYER, new Date());
    expect(mode(p)).toBe(0o600);
  });
});

describe("logging", () => {
  it("the escrow flow never logs the IOU secret key or the bearer token (even when the gateway echoes odd bodies)", async () => {
    const dir = tmpDir();
    const store = new IouKeyStore(join(dir, ".escrow-keys.json"));
    const logs: string[] = [];
    const g = maliciousEscrowGateway({
      lock: (k) => offer(k),
      purchase: () => ({ token: "hk_SUPERSECRET_TOKEN" }),
      calls: [
        () => json(200, { price: 1 }, { "x-hirakumi-sign-next": "1" }),
        () => json(418, { weird: true }),
      ],
    });
    await runEscrowPack({ fetch: g.fetch, buyEscrowPack: g.buyEscrowPack, store, refundAddress: BUYER, log: (l) => logs.push(l), sleep: async () => {}, now: () => new Date() }, flowOpts(2));
    const secret = (JSON.parse(readFileSync(join(dir, ".escrow-keys.json"), "utf8")) as Record<string, { secretKey: string }>)["api_demo/pk_demo"]!.secretKey;
    const all = logs.join("\n");
    expect(all).not.toContain(secret);
    expect(all).not.toContain("hk_SUPERSECRET_TOKEN");
  });
});
