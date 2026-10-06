import { randomBytes } from "node:crypto";
import {
  buildBaseAddress, buildEd25519PrivateKeyFromSecretKey, checkSignature, Hash28ByteBase16, signData,
} from "@meshsdk/core-cst";

export type TestWallet = {
  bech32: string;
  addressHex: string;
  sign(message: string): { signature: string; key: string };
  signHex(payloadHex: string): { signature: string; key: string };
};

let sodiumReady = false;

/** checkSignature awaits libsodium's ready() before parsing, so one call with junk input initialises it. */
async function ensureSodium(): Promise<void> {
  if (sodiumReady) return;
  await checkSignature("00", { signature: "00", key: "00" }).catch(() => undefined);
  sodiumReady = true;
}

/** A software wallet that produces CIP-30 style COSE_Sign1 signatures, like Eternl does. */
export async function makeTestWallet(networkId: 0 | 1 = 0): Promise<TestWallet> {
  await ensureSodium();
  const payment = buildEd25519PrivateKeyFromSecretKey(randomBytes(32).toString("hex"));
  const stake = buildEd25519PrivateKeyFromSecretKey(randomBytes(32).toString("hex"));
  const address = buildBaseAddress(
    networkId,
    Hash28ByteBase16(payment.toPublic().hash().hex()),
    Hash28ByteBase16(stake.toPublic().hash().hex()),
  ).toAddress();
  const signHex = (payloadHex: string) => signData(payloadHex, { address, key: payment });
  return {
    bech32: address.toBech32(),
    addressHex: address.toBytes(),
    signHex,
    sign: (message: string) => signHex(Buffer.from(message, "utf8").toString("hex")),
  };
}
