// Independent verifier: wallet-proof address forms (L6) and CSRF guard edge cases (L7).
import { randomBytes } from "node:crypto";
import {
  Address, buildBaseAddress, buildEd25519PrivateKeyFromSecretKey, buildEnterpriseAddress, CredentialType,
  Hash28ByteBase16, signData,
} from "@meshsdk/core-cst";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestWallet } from "@/test/wallet-fixture";
import { verifyCip30Signature } from "./cardano";
import { sameOrigin } from "./http";

const key = () => buildEd25519PrivateKeyFromSecretKey(randomBytes(32).toString("hex"));
const h28 = (k: ReturnType<typeof key>) => Hash28ByteBase16(k.toPublic().hash().hex());
const MSG = "Hirakumi ownership proof\nnonce: 42";
const hexOf = (s: string) => Buffer.from(s, "utf8").toString("hex");

describe("verify: wallet proof binds the PAYMENT key", () => {
  beforeEach(async () => { await makeTestWallet(); });

  it("liveness: base and enterprise addresses signed by their payment key pass", async () => {
    const pay = key();
    const base = buildBaseAddress(0, h28(pay), h28(key())).toAddress();
    const ent = buildEnterpriseAddress(0, h28(pay)).toAddress();
    expect(await verifyCip30Signature(MSG, signData(hexOf(MSG), { address: base, key: pay }), base.toBech32())).toBe(true);
    expect(await verifyCip30Signature(MSG, signData(hexOf(MSG), { address: ent, key: pay }), ent.toBech32())).toBe(true);
  });

  it("a signature presented for a different address with the same stake key is refused", async () => {
    const pay = key(), stake = key();
    const mine = buildBaseAddress(0, h28(pay), h28(stake)).toAddress();
    const victim = buildBaseAddress(0, h28(key()), h28(stake)).toAddress();
    const sig = signData(hexOf(MSG), { address: mine, key: pay });
    expect(await verifyCip30Signature(MSG, sig, victim.toBech32())).toBe(false);
    // And the stake key itself, signing for the victim address, is refused.
    expect(await verifyCip30Signature(MSG, signData(hexOf(MSG), { address: victim, key: stake }), victim.toBech32())).toBe(false);
  });

  it("an address whose payment part is a SCRIPT hash equal to the signer's key hash is refused", async () => {
    const pay = key();
    // Header type 7 = enterprise address with a script payment credential; type 3 = base, script payment + key stake.
    for (const type of [7, 3]) {
      const scriptAddr = new Address({
        type: type as never,
        networkId: 0,
        paymentPart: { type: CredentialType.ScriptHash, hash: h28(pay) },
        ...(type === 3 ? { delegationPart: { type: CredentialType.KeyHash, hash: h28(key()) } } : {}),
      } as never);
      const bech = scriptAddr.toBech32();
      expect(Address.fromBech32(bech).getProps().paymentPart?.type).toBe(CredentialType.ScriptHash);
      expect(await verifyCip30Signature(MSG, signData(hexOf(MSG), { address: scriptAddr, key: pay }), bech), `type ${type}`).toBe(false);
    }
  });
});

describe("verify: CSRF guard edge cases", () => {
  const saved = process.env.WEB_BASE_URL;
  afterEach(() => { if (saved === undefined) delete process.env.WEB_BASE_URL; else process.env.WEB_BASE_URL = saved; });
  const at = (headers: Record<string, string>, method = "POST") => new Request("https://app.hirakumi.test/api/apis/x/retire", { method, headers });

  it("sibling subdomain, other port, other scheme, 'null' and userinfo tricks are all refused", () => {
    process.env.WEB_BASE_URL = "https://app.hirakumi.test/";
    for (const origin of [
      "https://evil.hirakumi.test", "https://app.hirakumi.test:8443", "http://app.hirakumi.test", "null",
      "https://app.hirakumi.test.evil.example", "https://app.hirakumi.test@evil.example", "https://evil.example/https://app.hirakumi.test",
    ]) expect(sameOrigin(at({ origin })), origin).toBe(false);
    expect(sameOrigin(at({ "sec-fetch-site": "same-site", origin: "https://app.hirakumi.test" }))).toBe(false);
    expect(sameOrigin(at({ "sec-fetch-site": "cross-site" }, "post"))).toBe(false);
    expect(sameOrigin(at({ "sec-fetch-site": "cross-site" }, "PATCH"))).toBe(false);
  });

  it("liveness: trailing slash, default port and host case in WEB_BASE_URL / Origin still match", () => {
    process.env.WEB_BASE_URL = "https://App.Hirakumi.test:443/";
    expect(sameOrigin(at({ origin: "https://app.hirakumi.test" }))).toBe(true);
  });
});
