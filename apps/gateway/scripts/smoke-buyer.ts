import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { toClientCardanoSigner, USDM_PREPROD_ASSET } from "@x402/cardano";
import { ExactCardanoScheme } from "@x402/cardano/exact/client";

const [opUrl] = process.argv.slice(2);
const mnemonic = process.env.BUYER_MNEMONIC?.trim() ?? "";
const projectId = process.env.BLOCKFROST_PROJECT_ID?.trim() ?? "";
if (!opUrl || !mnemonic || !projectId) {
  console.error("usage: tsx scripts/smoke-buyer.ts <operationUrl>   (needs BUYER_MNEMONIC, BLOCKFROST_PROJECT_ID)");
  process.exit(1);
}

const first = await fetch(opUrl);
const offer = (await first.json()) as { packs?: Array<{ buyUrl: string; price: string; calls: number }> };
console.log(`1) no token → ${first.status}`, JSON.stringify(offer));
if (first.status !== 402 || !offer.packs?.length) process.exit(1);
const pack = offer.packs[0];

const client = new x402Client().setSpendControls({
  allowedAssets: [{ network: "cardano:*", asset: USDM_PREPROD_ASSET, maxAmountPerPayment: pack.price }],
});
const signer = toClientCardanoSigner({
  mnemonic, network: "cardano:preprod",
  provider: { blockfrost: { baseUrl: "https://cardano-preprod.blockfrost.io/api/v0", projectId } },
});
client.register("cardano:*", new ExactCardanoScheme(signer));

const t0 = Date.now();
const bought = await wrapFetchWithPayment(fetch, client)(pack.buyUrl, { method: "POST" });
const body = (await bought.json()) as { token?: string; credits?: number };
console.log(`2) buy pack (${pack.calls} calls, ${Number(pack.price) / 1e6} tUSDM) → ${bought.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
try {
  const receipt = new x402HTTPClient(client).getPaymentSettleResponse((n) => bought.headers.get(n));
  console.log(`   tx https://preprod.cardanoscan.io/transaction/${receipt.transaction}`);
} catch {
  console.log("   (no PAYMENT-RESPONSE receipt)");
}
if (!body.token) process.exit(1);

for (let i = 0; i < 3; i++) {
  const t1 = performance.now();
  const call = await fetch(opUrl, { headers: { authorization: `Bearer ${body.token}` } });
  console.log(`3.${i + 1}) call → ${call.status} credits=${call.headers.get("x-credits-remaining")} ${(performance.now() - t1).toFixed(0)}ms ${(await call.text()).slice(0, 120)}`);
}
console.log(`TOKEN=${body.token}`);
