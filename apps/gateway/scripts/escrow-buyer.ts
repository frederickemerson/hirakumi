import { randomBytes } from "node:crypto";
import { createPurchase } from "@hirakumi/masumi";

const [base, apiId, symbol = "ADA"] = process.argv.slice(2);
const baseUrl = process.env.PAYMENT_SERVICE_URL?.trim() ?? "";
const token = process.env.PAYMENT_SERVICE_TOKEN?.trim() ?? "";
if (!base || !apiId || !baseUrl || !token) {
  console.error("usage: tsx scripts/escrow-buyer.ts <gatewayBase> <apiId> [symbol]  (needs PAYMENT_SERVICE_URL/TOKEN)");
  process.exit(1);
}
const pid = randomBytes(10).toString("hex");
const started = await fetch(`${base}/a/${apiId}/start_job`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ input_data: { symbol }, identifier_from_purchaser: pid }),
});
const job = (await started.json()) as Record<string, string | number>;
console.log(`start_job → ${started.status}`, JSON.stringify(job));
if (!started.ok) process.exit(1);

const { purchaseId } = await createPurchase({ baseUrl, token, network: "Preprod" }, {
  agentIdentifier: String(job.agentIdentifier), blockchainIdentifier: String(job.blockchainIdentifier),
  inputHash: String(job.input_hash), identifierFromPurchaser: pid, sellerVKey: String(job.sellerVKey),
  payByTime: new Date(Number(job.payByTime)), submitResultTime: new Date(Number(job.submitResultTime)),
  unlockTime: new Date(Number(job.unlockTime)), externalDisputeUnlockTime: new Date(Number(job.externalDisputeUnlockTime)),
  amountMicros: BigInt(process.env.ESCROW_PRICE_MICROS ?? "1000000"),
});
console.log(`purchase ${purchaseId} created; funds lock on chain next`);

for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 10_000));
  const s = (await (await fetch(`${base}/a/${apiId}/status?job_id=${job.job_id}`)).json()) as { status: string };
  console.log(`${new Date().toISOString()} status=${s.status}`);
  if (s.status === "completed" || s.status === "failed") { console.log(JSON.stringify(s, null, 2)); break; }
}
