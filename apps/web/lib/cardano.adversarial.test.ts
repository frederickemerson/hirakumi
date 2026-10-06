import { randomBytes } from "node:crypto";
import { buildBaseAddress, buildEd25519PrivateKeyFromSecretKey, Hash28ByteBase16, signData } from "@meshsdk/core-cst";
import { describe, expect, it } from "vitest";
import { makeTestWallet } from "@/test/wallet-fixture";
import { createSessionToken, issueLoginChallenge, readSessionToken } from "./session";
import { verifyCip30Signature } from "./cardano";

describe("adversarial: wallet proof", () => {
  it("a stake-key signature does not prove control of the payout (payment) credential", async () => {
    await makeTestWallet(); // initialises libsodium
    const otherPaymentHash = randomBytes(28).toString("hex"); // a payment credential the signer does not hold
    const attackerStake = buildEd25519PrivateKeyFromSecretKey(randomBytes(32).toString("hex"));
    const address = buildBaseAddress(0, Hash28ByteBase16(otherPaymentHash), Hash28ByteBase16(attackerStake.toPublic().hash().hex())).toAddress();
    const message = "Hirakumi ownership proof\nnonce: 1";
    const sig = signData(Buffer.from(message, "utf8").toString("hex"), { address, key: attackerStake });
    expect(await verifyCip30Signature(message, sig, address.toBech32())).toBe(false);
  });
});

describe("adversarial: session tokens", () => {
  it("a login nonce token is never accepted as a session", () => {
    const { nonceToken } = issueLoginChallenge("addr_test1xyz");
    expect(readSessionToken(nonceToken)).toBeNull();
  });
  it("a tampered session payload is rejected", () => {
    const [, mac] = createSessionToken("sel_a", "addr_test1a").split(".");
    const forged = Buffer.from(JSON.stringify({ sid: "sel_b", addr: "addr_test1b", exp: 9e9 })).toString("base64url");
    expect(readSessionToken(`${forged}.${mac}`)).toBeNull();
  });
});
