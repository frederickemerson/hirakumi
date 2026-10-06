import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { masumiConfigFromEnv } from "../src/config.js";
import { MASUMI_ESCROW_UNIT } from "../src/constants.js";
import { createPaymentRequest, resolvePayment, submitResult, toPaymentState } from "../src/payments.js";
import { createPurchase, getPurchaseState } from "../src/purchases.js";
import { loadRootEnv } from "./env.js";
import { jcsFlat, mip004, parseStartJob, type StartJobTerms } from "./lib.js";

loadRootEnv();
const { values } = parseArgs({
  options: {
    mode: { type: "string" },
    agent: { type: "string" },
    gateway: { type: "string" },
    "seller-address": { type: "string" },
    "wait-collect": { type: "boolean", default: false },
  },
});
const mode = values.mode;
if (mode !== "pass" && mode !== "fail") throw new Error("--mode pass|fail is required");
const c = masumiConfigFromEnv();
const start = Date.now();
const events: Record<string, string> = {};
const log = (message: string) => console.log(`${new Date().toISOString()} +${Math.round((Date.now() - start) / 1000)}s ${message}`);
const mark = (event: string) => {
  if (events[event]) return;
  events[event] = new Date().toISOString();
  log(event);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const purchaser = randomBytes(10).toString("hex");
const input = { symbol: "ADA" };
const inputHash = mip004(purchaser, jcsFlat(input));

type Terms = Omit<StartJobTerms, "jobId" | "identifierFromPurchaser">;
let terms: Terms;
if (values.gateway) {
  const response = await fetch(`${values.gateway.replace(/\/+$/, "")}/start_job`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input_data: input, identifier_from_purchaser: purchaser }),
  });
  if (!response.ok) throw new Error(`start_job ${response.status}: ${await response.text()}`);
  const job = parseStartJob((await response.json()) as Record<string, unknown>);
  if (job.identifierFromPurchaser !== purchaser) throw new Error("start_job echoed another identifier_from_purchaser");
  if (job.inputHash !== inputHash) throw new Error("start_job input_hash is not MIP-004 of our input");
  log(`job_id=${job.jobId}`);
  terms = job;
} else {
  if (!values.agent) throw new Error("--agent <agentIdentifier> (direct mode) or --gateway <apiBaseUrl>");
  const now = Date.now();
  const payment = await createPaymentRequest(c, {
    agentIdentifier: values.agent,
    inputHash,
    identifierFromPurchaser: purchaser,
    payByTime: new Date(now + 10 * 60_000),
    submitResultTime: new Date(now + 20 * 60_000),
    ...(values["seller-address"] ? { sellerReturnAddress: values["seller-address"] } : {}),
  });
  terms = { ...payment, agentIdentifier: values.agent, inputHash };
}
const bc = terms.blockchainIdentifier;
mark("payment_request_created");
log(`submitResultTime=${terms.submitResultTime.toISOString()} unlockTime=${terms.unlockTime.toISOString()}`);

const seller = await resolvePayment(c, bc);
const price = seller.RequestedFunds.find((f) => f.unit === MASUMI_ESCROW_UNIT);
if (!price) throw new Error(`payment is not priced in Masumi tUSDM (${MASUMI_ESCROW_UNIT}): ${JSON.stringify(seller.RequestedFunds)}`);
const { purchaseId } = await createPurchase(c, {
  agentIdentifier: terms.agentIdentifier,
  blockchainIdentifier: bc,
  inputHash: terms.inputHash,
  identifierFromPurchaser: purchaser,
  sellerVKey: terms.sellerVKey,
  payByTime: terms.payByTime,
  submitResultTime: terms.submitResultTime,
  unlockTime: terms.unlockTime,
  externalDisputeUnlockTime: terms.externalDisputeUnlockTime,
  amountMicros: BigInt(price.amount),
});
mark("purchase_created");
log(`purchaseId=${purchaseId} price=${Number(price.amount) / 1e6} Masumi tUSDM sellerReturnAddress=${seller.sellerReturnAddress ?? "none"}`);

const hardStop =
  mode === "fail"
    ? terms.submitResultTime.getTime() + 30 * 60_000
    : values["wait-collect"]
      ? terms.unlockTime.getTime() + 20 * 60_000
      : terms.submitResultTime.getTime();
let submitted = false;
let lastLine = "";
for (;;) {
  const detail = await resolvePayment(c, bc);
  const sellerState = toPaymentState(detail.onChainState);
  const buyerState = await getPurchaseState(c, bc);
  const line = `payment=${sellerState} purchase=${buyerState} next=${detail.NextAction.requestedAction}${detail.NextAction.errorNote ? ` error=${detail.NextAction.errorNote}` : ""}`;
  if (line !== lastLine) log(line);
  lastLine = line;
  if (sellerState === "FundsLocked") mark("funds_locked");
  if (mode === "pass" && sellerState === "FundsLocked" && !submitted && !values.gateway) {
    await submitResult(c, bc, mip004(purchaser, JSON.stringify({ price: "0.42", symbol: "ADA" })));
    submitted = true;
    mark("result_submit_sent");
  }
  if (sellerState === "ResultSubmitted") {
    mark("result_submitted");
    if (mode === "pass" && !values["wait-collect"]) break;
  }
  if (sellerState === "Withdrawn") {
    mark("withdrawn_to_seller");
    break;
  }
  if (sellerState === "RefundWithdrawn" || buyerState === "RefundWithdrawn") {
    mark("refund_withdrawn");
    break;
  }
  if (Date.now() > hardStop) {
    log("timed out");
    break;
  }
  await sleep(20_000);
}

const ok =
  mode === "pass"
    ? Boolean(events.result_submitted) && (!values["wait-collect"] || Boolean(events.withdrawn_to_seller))
    : Boolean(events.refund_withdrawn) && !events.result_submitted;
console.log(
  JSON.stringify({
    mode,
    ok,
    purchaser,
    blockchainIdentifier: `${bc.slice(0, 32)}…`,
    terms: {
      payByTime: terms.payByTime.toISOString(),
      submitResultTime: terms.submitResultTime.toISOString(),
      unlockTime: terms.unlockTime.toISOString(),
    },
    events,
  }),
);
process.exit(ok ? 0 : 1);
