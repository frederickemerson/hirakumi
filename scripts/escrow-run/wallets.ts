// Creates (once) the throwaway operator/closer and fee-address wallets for the
// preprod escrow run. Mnemonics go to $ESCROW_RUN_SECRETS (mode 0600, outside
// git); only addresses and key hashes are ever printed.
import { existsSync, writeFileSync, chmodSync } from "node:fs";
import * as PrivateKey from "@evolution-sdk/evolution/PrivateKey";
import { loadEnv, walletFor } from "./lib.js";

const file = process.env.ESCROW_RUN_SECRETS;
if (!file) throw new Error("set ESCROW_RUN_SECRETS to a git-ignored file path");

if (!existsSync(file)) {
  const lines = [
    `OPERATOR_MNEMONIC="${PrivateKey.generateMnemonic(256)}"`,
    `FEE_MNEMONIC="${PrivateKey.generateMnemonic(256)}"`,
  ];
  writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
}
chmodSync(file, 0o600);
loadEnv();

for (const name of ["OPERATOR_MNEMONIC", "FEE_MNEMONIC", "BUYER_MNEMONIC"] as const) {
  const m = process.env[name];
  if (!m) continue;
  const w = walletFor(m);
  console.log(`${name.replace("_MNEMONIC", "").toLowerCase()}: ${w.address} vkh=${w.vkh}`);
}
