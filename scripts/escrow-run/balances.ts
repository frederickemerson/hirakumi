// Prints lovelace / tUSDM balances and UTxO counts of the run's wallets.
import { loadEnv, need, walletFor } from "./lib.js";

loadEnv();
const base = need("BLOCKFROST_BASE_URL");
const pid = need("BLOCKFROST_PROJECT_ID");
const USDM = "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c90014df10745553444d";

const who: Record<string, string> = {
  buyer: need("BUYER_ADDRESS"),
  seller: need("SELLER_ADDRESS"),
};
if (process.env.OPERATOR_MNEMONIC) who.operator = walletFor(process.env.OPERATOR_MNEMONIC).address;
if (process.env.FEE_MNEMONIC) who.fee = walletFor(process.env.FEE_MNEMONIC).address;
if (process.env.OPERATOR_MNEMONIC) who.refholder = walletFor(process.env.OPERATOR_MNEMONIC, 1).address;
if (process.argv[2]) who.extra = process.argv[2];

for (const [name, addr] of Object.entries(who)) {
  const r = await fetch(`${base}/addresses/${addr}/utxos?count=100`, { headers: { project_id: pid } });
  if (r.status === 404) {
    console.log(`${name.padEnd(9)} ${addr.slice(0, 24)}… empty`);
    continue;
  }
  const utxos = (await r.json()) as { amount: { unit: string; quantity: string }[] }[];
  let ada = 0n;
  let usdm = 0n;
  for (const u of utxos) for (const a of u.amount) {
    if (a.unit === "lovelace") ada += BigInt(a.quantity);
    if (a.unit === USDM) usdm += BigInt(a.quantity);
  }
  console.log(`${name.padEnd(9)} ${addr.slice(0, 24)}… ${Number(ada) / 1e6} tADA, ${Number(usdm) / 1e6} tUSDM, ${utxos.length} utxos`);
}
