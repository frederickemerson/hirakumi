import { masumiConfigFromEnv } from "../src/config.js";
import { call } from "../src/http.js";
import { MASUMI_ESCROW_UNIT, PAYMENT_SOURCE_TYPE } from "../src/constants.js";
import { getRegistryStatus } from "../src/registry.js";
import { loadRootEnv } from "./env.js";

loadRootEnv();
const c = masumiConfigFromEnv();
const V2_PREPROD_ESCROW = "addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g";
const BLOCKFROST = "https://cardano-preprod.blockfrost.io/api/v0";
const rows: Array<{ check: string; ok: boolean; detail: string }> = [];

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    rows.push({ check: name, ok: true, detail: await fn() });
  } catch (error) {
    rows.push({ check: name, ok: false, detail: (error as Error).message });
  }
}

async function balance(address: string): Promise<{ lovelace: bigint; escrowUnit: bigint }> {
  const key = process.env.BLOCKFROST_PROJECT_ID;
  if (!key) throw new Error("BLOCKFROST_PROJECT_ID not set");
  const response = await fetch(`${BLOCKFROST}/addresses/${address}`, { headers: { project_id: key } });
  if (response.status === 404) return { lovelace: 0n, escrowUnit: 0n };
  if (!response.ok) throw new Error(`Blockfrost ${response.status}`);
  const { amount } = (await response.json()) as { amount: Array<{ unit: string; quantity: string }> };
  const quantity = (unit: string) => BigInt(amount.find((a) => a.unit === unit)?.quantity ?? "0");
  return { lovelace: quantity("lovelace"), escrowUnit: quantity(MASUMI_ESCROW_UNIT) };
}

await check("health", async () => {
  const health = await call<{ status: string }>(c.baseUrl, c.token, "GET", "/health");
  if (health.status !== "ok") throw new Error(`status=${health.status}`);
  return "ok";
});

await check("api key accepted", async () => {
  await call<unknown>(c.baseUrl, c.token, "GET", "/api-key-status");
  return "token valid";
});

let sourceId = "";
await check("V2 preprod payment source", async () => {
  const { PaymentSources } = await call<{
    PaymentSources: Array<{ id: string; network: string; paymentSourceType: string; smartContractAddress: string }>;
  }>(c.baseUrl, c.token, "GET", "/payment-source", { query: { take: 100 } });
  const source = PaymentSources.find((s) => s.network === c.network && s.paymentSourceType === PAYMENT_SOURCE_TYPE);
  if (!source) throw new Error("not seeded");
  if (source.smartContractAddress !== V2_PREPROD_ESCROW) throw new Error(`unexpected escrow ${source.smartContractAddress}`);
  sourceId = source.id;
  return source.smartContractAddress;
});

const minimums: Array<[string, bigint, bigint]> = [
  ["Selling", 30_000_000n, 0n],
  ["Purchasing", 30_000_000n, 3_000_000n],
];
for (const [walletType, minLovelace, minEscrowUnit] of minimums) {
  await check(`${walletType} wallet funded`, async () => {
    const { Wallets } = await call<{ Wallets: Array<{ walletAddress: string }> }>(c.baseUrl, c.token, "GET", "/wallet/list", {
      query: { walletType, paymentSourceId: sourceId, take: 10 },
    });
    if (!Wallets[0]) throw new Error("no wallet");
    const b = await balance(Wallets[0].walletAddress);
    const detail = `${Wallets[0].walletAddress} ${Number(b.lovelace) / 1e6} tADA, ${Number(b.escrowUnit) / 1e6} Masumi tUSDM`;
    if (b.lovelace < minLovelace || b.escrowUnit < minEscrowUnit) throw new Error(`underfunded: ${detail}`);
    return detail;
  });
}

await check("live OpenAPI has every field packages/masumi sends", async () => {
  const response = await fetch(`${new URL(c.baseUrl).origin}/api-docs`);
  if (!response.ok) throw new Error(`/api-docs returned ${response.status}`);
  const spec = await response.text();
  const required = [
    "/payment/submit-result", "/payment/resolve-blockchain-identifier", "/purchase/resolve-blockchain-identifier",
    "/wallet/list", "/registry", "/payment-source", "supportedPaymentSourceIndex", "supportedPaymentSources",
    "sellerReturnAddress", "submitResultHash", "sellerVkey", "sellingWalletVkey", "identifierFromPurchaser",
    "externalDisputeUnlockTime", "smartContractAddress", "filterPaymentSourceType",
  ];
  const missing = required.filter((name) => !spec.includes(name));
  if (missing.length > 0) throw new Error(`missing in live spec: ${missing.join(", ")}`);
  return `${required.length} names present`;
});

if (c.registryToken) {
  await check("registry service reachable", async () => `unknown id → ${await getRegistryStatus(c, "0".repeat(120))}`);
} else {
  rows.push({ check: "registry service reachable", ok: false, detail: "REGISTRY_API_KEY not set" });
}

console.table(rows);
process.exit(rows.every((r) => r.ok) ? 0 : 1);
