import { describe, expect, it } from "vitest";
import { makeTestWallet } from "@/test/wallet-fixture";
import { AddressError, toPreprodBech32, utf8ToHex, verifyCip30Signature } from "./cardano";

describe("toPreprodBech32", () => {
  it("turns the hex address a CIP-30 wallet returns into bech32", async () => {
    const w = await makeTestWallet();
    expect(toPreprodBech32(w.addressHex)).toBe(w.bech32);
    expect(w.bech32.startsWith("addr_test1")).toBe(true);
  });

  it("accepts a bech32 preprod address unchanged", async () => {
    const w = await makeTestWallet();
    expect(toPreprodBech32(w.bech32)).toBe(w.bech32);
  });

  it("rejects mainnet addresses with a plain-English hint", async () => {
    const mainnet = await makeTestWallet(1);
    expect(() => toPreprodBech32(mainnet.addressHex)).toThrow(AddressError);
    expect(() => toPreprodBech32(mainnet.addressHex)).toThrow("Switch your wallet to the Cardano preprod test network, then try again.");
  });

  it("rejects garbage", () => {
    expect(() => toPreprodBech32("not-an-address")).toThrow("That wallet address could not be read.");
  });
});

describe("verifyCip30Signature", () => {
  it("accepts a signature by the claimed address over the exact message", async () => {
    const w = await makeTestWallet();
    const message = "Sign in to Hirakumi\nNonce: 1";
    expect(await verifyCip30Signature(message, w.sign(message), w.bech32)).toBe(true);
  });

  it("rejects a tampered message", async () => {
    const w = await makeTestWallet();
    expect(await verifyCip30Signature("Nonce: 2", w.sign("Nonce: 1"), w.bech32)).toBe(false);
  });

  it("rejects a signature made by a different wallet", async () => {
    const a = await makeTestWallet();
    const b = await makeTestWallet();
    expect(await verifyCip30Signature("hello", b.sign("hello"), a.bech32)).toBe(false);
  });

  it("returns false (never throws) for malformed input", async () => {
    const w = await makeTestWallet();
    expect(await verifyCip30Signature("hello", { signature: "zz", key: "zz" }, w.bech32)).toBe(false);
    expect(await verifyCip30Signature("hello", { signature: "84a4", key: "a401" }, w.bech32)).toBe(false);
  });

  it("encodes text as UTF-8 hex the same way the browser does", () => {
    expect(utf8ToHex("Hé")).toBe("48c3a9");
  });
});
