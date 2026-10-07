import { describe, it, expect, vi } from "vitest";
import { inputHash, outputHash } from "@hirakumi/core";
import { USDM_PREPROD_ASSET } from "@x402/cardano";
import { runEscrowJob, WrongEscrowAssetError, InputHashMismatchError, type EscrowOptions, type JobStatus } from "../src/escrowBuyer.js";
import { json, GW, API, MASUMI_UNIT } from "./fakeGateway.js";
import type { FetchLike } from "../src/gatewayClient.js";

const T = Date.UTC(2026, 9, 6, 8, 0, 0);
const PURCHASER = "a1b2c3d4e5f60718293a";
const OUTPUT = '{"symbol":"ADA","usd":0.27,"change24h":1.2,"timestamp":"2026-10-06T08:00:00.000Z"}';

function fakeEscrow(o: { statuses: JobStatus["status"][]; unit?: string; badInputHash?: boolean; down?: boolean; reasons?: string[]; output?: string }) {
  const out = o.output ?? OUTPUT;
  const statuses = [...o.statuses];
  const fetch: FetchLike = async (url, init) => {
    if (url.endsWith("/start_job")) {
      if (o.down) return json(503, { status: "unavailable", message: "API is Down" });
      const body = JSON.parse(String(init?.body)) as { identifier_from_purchaser: string; input_data: Record<string, unknown> };
      return json(200, {
        job_id: "job_1", blockchainIdentifier: "bc_1", agentIdentifier: "agent_1", sellerVKey: "vkey_1",
        // Contract v1.1 G7: the gateway sends epoch-ms numbers.
          payByTime: T + 600_000, submitResultTime: T + 900_000, unlockTime: T + 1_200_000, externalDisputeUnlockTime: T + 1_500_000,
        input_hash: o.badInputHash ? "0".repeat(64) : inputHash(body.identifier_from_purchaser, body.input_data),
        amounts: [{ amount: "1000000", unit: o.unit ?? MASUMI_UNIT }],
      });
    }
    if (url.includes("/status?job_id=job_1")) {
      const status = statuses.shift() ?? "running";
      if (status === "completed") return json(200, { job_id: "job_1", status, output: out, output_hash: outputHash(PURCHASER, out) });
      if (status === "failed") return json(200, { job_id: "job_1", status, reasons: o.reasons ?? ["/usd is required"] });
      return json(200, { job_id: "job_1", status });
    }
    return json(404, { error: "not_found" });
  };
  return fetch;
}

const opts: EscrowOptions = { gatewayUrl: GW, apiId: API, input: { symbol: "ADA" }, escrowUnit: MASUMI_UNIT, maxEscrowMicros: 5_000_000n, pollMs: 5_000, timeoutMs: 60_000 };

function makeDeps(fetch: FetchLike) {
  let now = T;
  const lines: string[] = [];
  return {
    lines,
    deps: {
      fetch,
      createPurchase: vi.fn(async () => ({ purchaseId: "pur_1" })),
      inputHash,
      outputHash,
      log: (l: string) => lines.push(l),
      sleep: async (ms: number) => { now += ms; },
      now: () => now,
      newPurchaserId: () => PURCHASER,
    },
  };
}

describe("runEscrowJob", () => {
  it("locks funds with the exact start_job terms and returns a verified result", async () => {
    const h = makeDeps(fakeEscrow({ statuses: ["awaiting_payment", "running", "completed"] }));
    const r = await runEscrowJob(h.deps, opts);
    expect(r).toEqual({ outcome: "completed", output: OUTPUT, outputVerified: true });
    expect(h.deps.createPurchase).toHaveBeenCalledWith({
      agentIdentifier: "agent_1", blockchainIdentifier: "bc_1", inputHash: inputHash(PURCHASER, { symbol: "ADA" }),
      identifierFromPurchaser: PURCHASER, sellerVKey: "vkey_1",
      payByTime: new Date(T + 600_000), submitResultTime: new Date(T + 900_000), unlockTime: new Date(T + 1_200_000),
      externalDisputeUnlockTime: new Date(T + 1_500_000), amountMicros: 1_000_000n,
    });
  });

  it("returns and prints a text answer as it came", async () => {
    const csv = "symbol,usd\nADA,0.27\n";
    const h = makeDeps(fakeEscrow({ statuses: ["completed"], output: csv }));
    const r = await runEscrowJob(h.deps, opts);
    expect(r).toEqual({ outcome: "completed", output: csv, outputVerified: true });
    expect(h.lines).toContain(`Result: \n${csv}`);
  });

  it("on failure prints reasons and the automatic refund time", async () => {
    const h = makeDeps(fakeEscrow({ statuses: ["running", "failed"] }));
    const r = await runEscrowJob(h.deps, opts);
    expect(r).toEqual({ outcome: "failed", reasons: ["/usd is required"], refundAfter: new Date(T + 900_000) });
    expect(h.lines.join("\n")).toContain(`refunds automatically after ${new Date(T + 900_000).toISOString()}`);
  });

  it("refuses a job priced in the x402 pack asset without calling createPurchase", async () => {
    const h = makeDeps(fakeEscrow({ statuses: [], unit: USDM_PREPROD_ASSET.replace(".", "") }));
    await expect(runEscrowJob(h.deps, opts)).rejects.toThrow(WrongEscrowAssetError);
    expect(h.deps.createPurchase).not.toHaveBeenCalled();
  });

  it("refuses to lock funds when the gateway hashed a different input", async () => {
    const h = makeDeps(fakeEscrow({ statuses: [], badInputHash: true }));
    await expect(runEscrowJob(h.deps, opts)).rejects.toThrow(InputHashMismatchError);
    expect(h.deps.createPurchase).not.toHaveBeenCalled();
  });

  it("returns down on 503 without locking", async () => {
    const h = makeDeps(fakeEscrow({ statuses: [], down: true }));
    expect(await runEscrowJob(h.deps, opts)).toEqual({ outcome: "down", message: "API is Down" });
    expect(h.deps.createPurchase).not.toHaveBeenCalled();
  });

  it("times out if the job never finishes", async () => {
    const h = makeDeps(fakeEscrow({ statuses: Array(100).fill("running") }));
    await expect(runEscrowJob(h.deps, { ...opts, timeoutMs: 20_000 })).rejects.toThrow(/did not finish/);
  });
});
