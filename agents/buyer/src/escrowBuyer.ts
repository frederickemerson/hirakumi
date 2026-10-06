import { formatAnswer, formatMicros, messageOf, safeJson, type FetchLike } from "./gatewayClient.js";

export type StartJobResponse = {
  job_id: string; blockchainIdentifier: string; payByTime: number; submitResultTime: number; unlockTime: number;
  externalDisputeUnlockTime: number; agentIdentifier: string; sellerVKey: string; input_hash: string;
  amounts: { amount: string; unit: string }[];
};
export type JobStatus = {
  job_id: string; status: "awaiting_payment" | "running" | "completed" | "failed" | "expired";
  output?: string; output_hash?: string; reasons?: string[]; message?: string;
};
export type CreatePurchaseInput = {
  agentIdentifier: string; blockchainIdentifier: string; inputHash: string; identifierFromPurchaser: string; sellerVKey: string;
  payByTime: Date; submitResultTime: Date; unlockTime: Date; externalDisputeUnlockTime: Date; amountMicros: bigint;
};
export type EscrowDeps = {
  fetch: FetchLike;
  createPurchase: (p: CreatePurchaseInput) => Promise<{ purchaseId: string }>;
  inputHash: (identifier: string, input: unknown) => string;
  outputHash: (identifier: string, raw: string) => string;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  newPurchaserId: () => string;
};
export type EscrowOptions = {
  gatewayUrl: string; apiId: string; input: Record<string, unknown>; escrowUnit: string; maxEscrowMicros: bigint; pollMs: number; timeoutMs: number;
};
export type EscrowResult =
  | { outcome: "completed"; output: string; outputVerified: boolean }
  | { outcome: "failed"; reasons: string[]; refundAfter: Date }
  | { outcome: "expired" }
  | { outcome: "down"; message: string };

export class WrongEscrowAssetError extends Error {}
export class InputHashMismatchError extends Error {}

const STRING_FIELDS = ["job_id", "blockchainIdentifier", "agentIdentifier", "sellerVKey", "input_hash"] as const;
const TIME_FIELDS = ["payByTime", "submitResultTime", "unlockTime", "externalDisputeUnlockTime"] as const;
const STATUSES = ["awaiting_payment", "running", "completed", "failed", "expired"];

export function parseStartJob(body: unknown): StartJobResponse {
  const b = body as Record<string, unknown> | undefined;
  if (!b) throw new Error("start_job returned no JSON");
  for (const f of STRING_FIELDS) if (typeof b[f] !== "string" || b[f] === "") throw new Error(`start_job response lacks ${f}`);
  // Contract v1.1 G7: epoch-ms numbers. Digit strings are accepted too and normalised to numbers.
  for (const f of TIME_FIELDS) {
    const v = b[f];
    const ms = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
    if (!Number.isSafeInteger(ms) || ms <= 0) throw new Error(`start_job ${f} must be an epoch-ms number`);
    b[f] = ms;
  }
  const amounts = b.amounts;
  if (!Array.isArray(amounts) || amounts.some((a) => typeof a?.amount !== "string" || !/^\d+$/.test(a.amount) || typeof a?.unit !== "string")) {
    throw new Error("start_job amounts must be [{amount: micros string, unit}]");
  }
  return b as unknown as StartJobResponse;
}

export function parseJobStatus(body: unknown): JobStatus {
  const b = body as Partial<JobStatus> | undefined;
  if (!b || typeof b.job_id !== "string" || typeof b.status !== "string" || !STATUSES.includes(b.status)) {
    throw new Error(`bad /status response: ${JSON.stringify(body)}`);
  }
  return b as JobStatus;
}

const msDate = (ms: number) => new Date(ms);

export async function runEscrowJob(deps: EscrowDeps, o: EscrowOptions): Promise<EscrowResult> {
  const purchaserId = deps.newPurchaserId();
  const base = new URL(`/a/${encodeURIComponent(o.apiId)}/`, o.gatewayUrl);
  deps.log(`Starting a job on ${o.apiId} with input ${JSON.stringify(o.input)} (purchaser id ${purchaserId})`);

  const res = await deps.fetch(new URL("start_job", base).toString(), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ identifier_from_purchaser: purchaserId, input_data: o.input }),
  });
  const text = await res.text();
  if (res.status === 503) {
    const message = messageOf(safeJson(text), text);
    deps.log(`503 Down: ${message}. Nothing locked.`);
    return { outcome: "down", message };
  }
  if (!res.ok) throw new Error(`start_job failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  const job = parseStartJob(safeJson(text));

  if (job.amounts.length !== 1 || job.amounts[0].unit !== o.escrowUnit) {
    throw new WrongEscrowAssetError(`Job is priced in ${JSON.stringify(job.amounts)}; this buyer only pays escrow jobs in ${o.escrowUnit}`);
  }
  const amount = BigInt(job.amounts[0].amount);
  if (amount > o.maxEscrowMicros) throw new Error(`Job costs ${amount} micros, above the cap of ${o.maxEscrowMicros}`);
  const expected = deps.inputHash(purchaserId, o.input);
  if (job.input_hash !== expected) {
    throw new InputHashMismatchError(`Gateway input_hash ${job.input_hash} does not match ours (${expected}); not locking funds`);
  }

  deps.log(`Job ${job.job_id}: ${formatMicros(amount)} tUSDM in Masumi escrow; result due by ${msDate(job.submitResultTime).toISOString()}`);
  const { purchaseId } = await deps.createPurchase({
    agentIdentifier: job.agentIdentifier,
    blockchainIdentifier: job.blockchainIdentifier,
    inputHash: job.input_hash,
    identifierFromPurchaser: purchaserId,
    sellerVKey: job.sellerVKey,
    payByTime: msDate(job.payByTime),
    submitResultTime: msDate(job.submitResultTime),
    unlockTime: msDate(job.unlockTime),
    externalDisputeUnlockTime: msDate(job.externalDisputeUnlockTime),
    amountMicros: amount,
  });
  deps.log(`Purchase ${purchaseId} created: locking funds in escrow...`);

  const statusUrl = new URL("status", base);
  statusUrl.searchParams.set("job_id", job.job_id);
  const deadline = deps.now() + o.timeoutMs;
  let last = "";
  while (deps.now() < deadline) {
    const sr = await deps.fetch(statusUrl.toString(), { headers: { accept: "application/json" } });
    const st = parseJobStatus(safeJson(await sr.text()));
    if (st.status !== last) {
      deps.log(`status: ${st.status}`);
      last = st.status;
    }
    if (st.status === "completed") {
      const output = st.output ?? "";
      const outputVerified = st.output_hash !== undefined && st.output_hash === deps.outputHash(purchaserId, output);
      // The output is the API's answer as text: JSON, CSV, XML or plain text.
      deps.log(`Result: ${formatAnswer(output)}`);
      deps.log(outputVerified ? "Output hash verified (MIP-004)." : "OUTPUT HASH MISMATCH: dispute before the dispute window closes.");
      return { outcome: "completed", output, outputVerified };
    }
    if (st.status === "failed") {
      const reasons = st.reasons ?? (st.message ? [st.message] : []);
      const refundAfter = msDate(job.submitResultTime);
      deps.log(`Failed, promise not met: ${reasons.join("; ")}`);
      deps.log(`No result was submitted, so Masumi refunds automatically after ${refundAfter.toISOString()}. No action needed.`);
      return { outcome: "failed", reasons, refundAfter };
    }
    if (st.status === "expired") {
      deps.log("Expired: funds were never locked in time.");
      return { outcome: "expired" };
    }
    await deps.sleep(o.pollMs);
  }
  throw new Error(`Job ${job.job_id} did not finish within ${o.timeoutMs}ms`);
}
