import {
  Address,
  addressToBech32,
  checkSignature,
  CredentialType,
  deserializeAddress,
  Ed25519PublicKey,
  getPublicKeyFromCoseKey,
} from "@meshsdk/core-cst";

export class AddressError extends Error {}

export type Cip30Signature = { signature: string; key: string };

const HEX = /^[0-9a-fA-F]+$/;

/** CIP-30 wallets hand out hex address bytes; sellers are stored as bech32. Preprod only. */
export function toPreprodBech32(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length < 20 || trimmed.length > 256) throw new AddressError("That wallet address could not be read.");
  let bech32: string;
  try {
    bech32 = addressToBech32(deserializeAddress(trimmed));
  } catch {
    throw new AddressError("That wallet address could not be read.");
  }
  if (!bech32.startsWith("addr_test1")) {
    throw new AddressError("Switch your wallet to the Cardano preprod test network, then try again.");
  }
  return bech32;
}

export function utf8ToHex(s: string): string {
  return Buffer.from(s, "utf8").toString("hex");
}

/**
 * Verifies a CIP-30 signData result. The wallet signed utf8ToHex(message), and we pass that same hex
 * so Mesh compares bytes directly. Mesh's address check also accepts the address's stake key, so we
 * require the signing key's blake2b-224 hash to equal the address's payment key hash ourselves:
 * only the key that controls the payout credential can prove the address.
 */
export async function verifyCip30Signature(message: string, sig: Cip30Signature, bech32: string): Promise<boolean> {
  if (!HEX.test(sig.signature) || !HEX.test(sig.key)) return false;
  try {
    const ok = await checkSignature(utf8ToHex(message), sig, bech32);
    if (!ok) return false;
    const pkh = Ed25519PublicKey.fromBytes(getPublicKeyFromCoseKey(sig.key)).hash().hex();
    const pay = Address.fromBech32(bech32).getProps().paymentPart;
    return pay?.type === CredentialType.KeyHash && pay.hash === pkh;
  } catch {
    return false;
  }
}
