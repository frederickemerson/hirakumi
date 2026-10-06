// Shared plumbing for the preprod escrow run. Never prints secrets.
import { existsSync } from "node:fs";
import * as Address from "@evolution-sdk/evolution/Address";
import { addressFromSeed } from "@evolution-sdk/evolution/sdk/wallet/Derivation";

/** Loads ENV_FILE (default: the main checkout's .env) and ESCROW_RUN_SECRETS without overriding the shell. */
export function loadEnv(): void {
  const before = { ...process.env };
  for (const f of [process.env.ENV_FILE, process.env.ESCROW_RUN_SECRETS]) {
    if (f && existsSync(f)) process.loadEnvFile(f);
  }
  Object.assign(process.env, before);
}

export function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

const norm = (m: string) => m.trim().replace(/\s+/g, " ").toLowerCase();

/** Address (base, account 0) and payment key hash of a mnemonic, the same derivation the x402 signer uses. */
export function walletFor(mnemonic: string, accountIndex = 0): { address: string; vkh: string } {
  const { address } = addressFromSeed(norm(mnemonic), { accountIndex, networkId: 0 });
  const bech = Address.toBech32(address);
  const pc = address.paymentCredential as { hash: Uint8Array };
  return { address: bech, vkh: Buffer.from(pc.hash).toString("hex") };
}

export const seedConfig = (mnemonic: string, accountIndex = 0) => ({ mnemonic: norm(mnemonic), accountIndex });
