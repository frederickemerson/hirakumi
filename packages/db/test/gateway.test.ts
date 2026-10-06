import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../src/testing";
import {
  activateTokenByPayment, claimJob, insertJob, insertPendingToken, listJobsAwaitingPayment, loadApiBundle,
  markExhaustedIfEmpty, recordHealthTransition, releaseCredit, reserveCredit,
} from "../src/gateway";

let db: TestDb;
beforeEach(async () => {
  db = await createTestDb();
  const sql = db.sql;
  await sql`insert into sellers (id, cardano_addr) values ('sel_a', 'addr_test1qseller')`;
  await sql`insert into apis (id, seller_id, name, origin, openapi_url, state) values ('api_a', 'sel_a', 'Price', 'https://p.example', 'https://p.example/openapi.json', 'live')`;
  await sql`insert into operations (id, api_id, op_id, method, path, input_schema, enabled) values ('op_a', 'api_a', 'getPrice', 'GET', '/price', '{"type":"object"}', true)`;
  await sql`insert into rules (id, operation_id, version, definition, hash) values ('rule_1', 'op_a', 1, '{"v":1}', 'sha256:1'), ('rule_2', 'op_a', 2, '{"v":2}', 'sha256:2')`;
  await sql`insert into packs (id, api_id, calls, price_micros, escrow_price_micros) values ('pk_a', 'api_a', 100, 2000000, 1000000)`;
});
afterEach(async () => { await db.drop(); });

const pending = (over: Partial<Parameters<typeof insertPendingToken>[1]> = {}) => ({
  id: "ct_1", apiId: "api_a", packId: "pk_a", tokenHash: "th1", remaining: 1, paymentPayloadHash: "pp1", txHash: null, ...over,
});

describe("loadApiBundle", () => {
  it("joins the seller address and keeps only the latest rule version per operation", async () => {
    const b = await loadApiBundle(db.sql, "api_a");
    expect(b?.api.pay_to).toBe("addr_test1qseller");
    expect(b?.rules.map((r) => r.id)).toEqual(["rule_2"]);
    expect(b?.packs[0]).toMatchObject({ id: "pk_a", calls: 100, price_micros: "2000000" });
    expect(await loadApiBundle(db.sql, "api_missing")).toBeNull();
  });
});

describe("credit tokens", () => {
  it("insertPendingToken is idempotent on the payment hash", async () => {
    expect(await insertPendingToken(db.sql, pending())).toEqual({ inserted: true, id: "ct_1" });
    expect(await insertPendingToken(db.sql, pending({ id: "ct_2", tokenHash: "th2" }))).toEqual({ inserted: false, id: "ct_1", status: "pending" });
  });
  it("a pending token cannot be reserved; activation flips it once", async () => {
    await insertPendingToken(db.sql, pending());
    expect(await reserveCredit(db.sql, "api_a", "th1")).toEqual({ ok: false, reason: "pending" });
    expect(await activateTokenByPayment(db.sql, "pp1", "tx1", "addr_test1qbuyer")).toBe(true);
    expect(await activateTokenByPayment(db.sql, "pp1", "tx1", "addr_test1qbuyer")).toBe(false);
    expect(await reserveCredit(db.sql, "api_a", "th1")).toEqual({ ok: true, tokenId: "ct_1", remainingAfter: 0 });
    expect(await reserveCredit(db.sql, "other_api", "th1")).toEqual({ ok: false, reason: "not_found" });
  });
  it("reserveCredit race: 20 concurrent callers, exactly one wins the last credit", async () => {
    await insertPendingToken(db.sql, pending());
    await activateTokenByPayment(db.sql, "pp1", "tx1", null);
    const results = await Promise.all(Array.from({ length: 20 }, () => reserveCredit(db.sql, "api_a", "th1")));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === "exhausted")).toHaveLength(19);
  });
  it("release revives a token another request already marked exhausted (no lost credit)", async () => {
    await insertPendingToken(db.sql, pending({ remaining: 2 }));
    await activateTokenByPayment(db.sql, "pp1", "tx1", null);
    const a = await reserveCredit(db.sql, "api_a", "th1");
    const b = await reserveCredit(db.sql, "api_a", "th1");
    expect(a.ok && b.ok).toBe(true);
    await markExhaustedIfEmpty(db.sql, "ct_1");          // A passed: remaining 0 → exhausted
    await releaseCredit(db.sql, "ct_1");                 // B failed: give its credit back
    const [row] = await db.sql<{ status: string; remaining: number }[]>`select status, remaining from credit_tokens where id = 'ct_1'`;
    expect(row).toEqual({ status: "active", remaining: 1 });
    expect(await reserveCredit(db.sql, "api_a", "th1")).toMatchObject({ ok: true, remainingAfter: 0 });
  });
});

describe("jobs and health", () => {
  it("claimJob succeeds exactly once", async () => {
    await insertJob(db.sql, { id: "job_1", apiId: "api_a", identifierFromPurchaser: "aabbccddeeff0011", input: { symbol: "ADA" },
      inputHash: "ih", blockchainIdentifier: "bc1", payByTime: new Date(Date.now() + 60_000), submitResultTime: new Date(Date.now() + 120_000) });
    expect((await listJobsAwaitingPayment(db.sql)).map((j) => j.id)).toEqual(["job_1"]);
    const claims = await Promise.all([claimJob(db.sql, "job_1"), claimJob(db.sql, "job_1")]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });
  it("recordHealthTransition updates apis and writes one health_events row atomically", async () => {
    await recordHealthTransition(db.sql, "api_a", "healthy", "down", [{ op: "getPrice", reason: "/price is missing", since: "2026-10-06T12:00:00.000Z" }]);
    const [api] = await db.sql<{ health: string; health_checked_at: Date | null }[]>`select health, health_checked_at from apis where id = 'api_a'`;
    expect(api.health).toBe("down");
    expect(api.health_checked_at).not.toBeNull();
    const events = await db.sql<{ from_health: string; to_health: string; reasons: unknown }[]>`select from_health, to_health, reasons from health_events`;
    expect(events).toEqual([{ from_health: "healthy", to_health: "down", reasons: [{ op: "getPrice", reason: "/price is missing", since: "2026-10-06T12:00:00.000Z" }] }]);
  });
});
