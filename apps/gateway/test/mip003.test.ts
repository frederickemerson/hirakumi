import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { inputHash, outputHash } from "@hirakumi/core";
import { JobRunner } from "../src/jobs";
import { toMip003Fields } from "../src/mip003";
import { makeHarness, type Harness } from "./helpers";

let h: Harness; let runner: JobRunner;
const PID = "aabbccddeeff00112233";
beforeEach(async () => {
  h = await makeHarness();
  runner = new JobRunner({ sql: h.sql, registry: h.registry, masumi: h.masumi, config: h.config });
});
afterEach(async () => { runner.stop(); await h.close(); });

const start = (body: unknown) => request(h.app).post(`/a/${h.seeded.apiId}/start_job`).send(body as object);
const status = (jobId: string) => request(h.app).get(`/a/${h.seeded.apiId}/status`).query({ job_id: jobId });

describe("start_job", () => {
  it("creates a payment request with the MIP-004 input hash of input_data as sent", async () => {
    const input_data = [{ key: "symbol", value: "ADA" }];
    const r = await start({ input_data, identifier_from_purchaser: PID });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "awaiting_payment", identifierFromPurchaser: PID, agentIdentifier: "agent_test_1", sellerVKey: "vkey_test" });
    expect(r.body.job_id).toBe(r.body.id);
    // Contract v1.1 G7: amounts in the Masumi escrow unit, times as epoch-ms numbers.
    expect(r.body.amounts).toEqual([{ amount: "1000000", unit: "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d" }]);
    for (const k of ["payByTime", "submitResultTime", "unlockTime", "externalDisputeUnlockTime"]) expect(typeof r.body[k]).toBe("number");
    expect(r.body.input_hash).toBe(inputHash(PID, input_data));
    // Contract v1.1 M2: escrow pays the seller directly (non-custodial).
    expect(h.masumi.created).toEqual([{ agentIdentifier: "agent_test_1", inputHash: inputHash(PID, input_data), identifierFromPurchaser: PID, sellerReturnAddress: h.seeded.payTo }]);
    expect(typeof r.body.payByTime).toBe("number");
    expect((await status(r.body.job_id)).body).toMatchObject({ status: "awaiting_payment" });
  });
  it("400 for a bad purchaser id or input; no payment request is created", async () => {
    expect((await start({ input_data: { symbol: "ADA" }, identifier_from_purchaser: "not-hex" })).status).toBe(400);
    const bad = await start({ input_data: { nope: 1 }, identifier_from_purchaser: PID });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("INVALID_INPUT");
    expect(h.masumi.created).toHaveLength(0);
  });
  it("503 when the API is Down; no payment request is created", async () => {
    h.health.record(h.seeded.apiId, false, [{ op: "getPrice", reason: "x" }]);
    h.health.record(h.seeded.apiId, false, [{ op: "getPrice", reason: "x" }]);
    expect((await start({ input_data: { symbol: "ADA" }, identifier_from_purchaser: PID })).status).toBe(503);
    expect(h.masumi.created).toHaveLength(0);
  });
  it("503 when the API has no agent identifier yet", async () => {
    await h.sql`update apis set agent_identifier = null`;
    h.registry.invalidate(h.seeded.apiId);
    expect((await start({ input_data: { symbol: "ADA" }, identifier_from_purchaser: PID })).status).toBe(503);
  });
});

describe("start_job hardening (audit I1, I3)", () => {
  it("a purchaser id longer than the Masumi node accepts (26 hex) is a 400, not a 500", async () => {
    const r = await start({ input_data: { symbol: "ADA" }, identifier_from_purchaser: "ab".repeat(16) });
    expect(r.status).toBe(400);
    expect(h.masumi.created).toHaveLength(0);
  });
  it("one client can't flood start_job: the 11th request within a minute gets 429", async () => {
    for (let i = 0; i < 10; i++) expect((await start({ input_data: { symbol: "ADA" }, identifier_from_purchaser: PID })).status).toBe(200);
    const r = await start({ input_data: { symbol: "ADA" }, identifier_from_purchaser: PID });
    expect(r.status).toBe(429);
    expect(h.masumi.created).toHaveLength(10);
  });
});

describe("JobRunner", () => {
  async function newJob(): Promise<string> {
    return (await start({ input_data: { symbol: "ADA" }, identifier_from_purchaser: PID })).body.job_id as string;
  }

  it("waiting for payment never calls upstream", async () => {
    const id = await newJob();
    await runner.tick();
    expect(h.stub.hits()).toBe(0);
    expect((await status(id)).body.status).toBe("awaiting_payment");
  });

  it("pass: runs once funds are locked and submits the output hash", async () => {
    const id = await newJob();
    h.masumi.state = "FundsLocked";
    await runner.tick();
    expect(h.stub.hits()).toBe(1);
    const s = await status(id);
    expect(s.body).toMatchObject({ job_id: id, status: "completed", input_hash: inputHash(PID, { symbol: "ADA" }) });
    expect(s.body.output_hash).toBe(outputHash(PID, s.body.output));
    expect(h.masumi.submitted).toEqual([{ blockchainIdentifier: expect.stringMatching(/^bc_/), resultHash: s.body.output_hash }]);
    const [c] = await h.sql<{ kind: string; verdict: string; job_id: string }[]>`select kind, verdict, job_id from calls`;
    expect(c).toEqual({ kind: "escrow", verdict: "pass", job_id: id });
  });

  it("fail submits nothing and reports what failed", async () => {
    const id = await newJob();
    h.masumi.state = "FundsLocked";
    h.stub.setMode("empty");
    await runner.tick();
    expect(h.masumi.submitted).toHaveLength(0);
    const s = await status(id);
    expect(s.body).toMatchObject({ status: "failed", error: "promise_not_met" });
    expect(s.body.reasons).toContain("/price is missing");
    expect(s.body.message).toMatch(/refund/i);
  });

  it("expired: pay-by passed without locked funds → upstream never called", async () => {
    const id = await newJob();
    await h.sql`update jobs set pay_by_time = now() - interval '1 minute' where id = ${id}`;
    await runner.tick();
    expect(h.stub.hits()).toBe(0);
    expect((await status(id)).body).toMatchObject({ status: "failed", error: "payment_not_received" });
  });

  it("a submit that reached Masumi but errored locally is recorded as completed, never as refunded (audit I2)", async () => {
    const id = await newJob();
    h.masumi.state = "FundsLocked";
    const original = h.masumi.submitResult.bind(h.masumi);
    h.masumi.submitResult = async (b, r) => { await original(b, r); throw new Error("timeout after the node accepted it"); };
    await runner.tick();
    expect((await status(id)).body.status).toBe("running");
    h.masumi.state = "ResultSubmitted";
    await h.sql`update jobs set submit_result_time = now() - interval '1 minute' where id = ${id}`;
    await runner.tick();
    expect((await status(id)).body.status).toBe("completed");
    expect(h.masumi.submitted).toHaveLength(1);
  });

  it("a failed submit is retried on the next tick", async () => {
    const id = await newJob();
    h.masumi.state = "FundsLocked";
    const original = h.masumi.submitResult.bind(h.masumi);
    let calls = 0;
    h.masumi.submitResult = async (b, r) => { calls += 1; if (calls === 1) throw new Error("node busy"); return original(b, r); };
    await runner.tick();
    expect((await status(id)).body.status).toBe("running");
    await runner.tick();
    expect((await status(id)).body.status).toBe("completed");
    expect(h.stub.hits()).toBe(1);
  });
});

describe("status and input_schema", () => {
  it("404 for an unknown job", async () => {
    const r = await status("job_nope");
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("JOB_NOT_FOUND");
  });
  it("input_schema lists the escrow operation's fields in MIP-003 form", async () => {
    const r = await request(h.app).get(`/a/${h.seeded.apiId}/input_schema`);
    expect(r.body).toEqual({ input_data: [{ id: "symbol", type: "string", name: "symbol", data: { description: "Ticker, e.g. ADA" } }] });
  });
  it("toMip003Fields maps enums to options and numbers", () => {
    expect(toMip003Fields({ type: "object", properties: { n: { type: "integer", title: "Count" }, c: { enum: ["a", "b"] }, f: { type: "boolean" } } }))
      .toEqual([
        { id: "n", type: "number", name: "Count", data: {} },
        { id: "c", type: "option", name: "c", data: { options: ["a", "b"] } },
        { id: "f", type: "boolean", name: "f", data: {} },
      ]);
  });
});
