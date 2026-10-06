import { randomBytes } from "node:crypto";
import { newId } from "@hirakumi/core";
import { beforeEach, describe, expect, it } from "vitest";
import { getSql } from "@/lib/db";
import { API_DELETE_ORDER } from "@/lib/repo/delete-api";
import { resetDb } from "@/test/db";
import {
  seedApi, seedCall, seedCreditToken, seedHealthEvent, seedJob, seedOnboardStep, seedOperation, seedPack, seedRule, seedSeller,
} from "@/test/factories";
import { cookieFor, ctx } from "@/test/requests";
import { DELETE } from "./route";

function del(apiId: string, init: { cookie?: string; headers?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = { ...init.headers };
  if (init.cookie) headers.cookie = init.cookie;
  return new Request(`https://web.hirakumi.test/api/apis/${apiId}`, { method: "DELETE", headers });
}

/** One row in every table that hangs off an unfinished API (the ones a seller can create before publishing). */
async function seedUnfinished(sellerId: string) {
  const sql = getSql();
  const api = await seedApi(sellerId, "priced", { name: "Weather API" });
  const op = await seedOperation(api.id, { enabled: true });
  const rule = await seedRule(op.id);
  await sql`insert into test_inputs (id, operation_id, input) values (${newId("ti")}, ${op.id}, '{}'::jsonb)`;
  await seedOnboardStep(api.id, "parse", "done");
  await seedOnboardStep(api.id, "qa", "done");
  await sql`insert into challenges (id, api_id, kind, token, expires_at) values (${newId("ch")}, ${api.id}, 'http', 'tok', now() + interval '1 hour')`;
  await sql`insert into messages (seller_id, api_id, author, body) values (${sellerId}, ${api.id}, 'seller', 'hi')`;
  const pack = await seedPack(api.id);
  await sql`
    insert into pack_quotes (quote_key, channel_id, api_id, pack_id, receipt_key, refund_address, seller_address, fee_address,
      fee_bps, price_micros, price_per_call_micros, max_calls, unsigned_allowance, contest_period_ms, close_fee_budget_lovelace,
      datum_cbor, expires_at)
    values (${randomBytes(32).toString("hex")},${randomBytes(32).toString("hex")}, ${api.id}, ${pack.id}, 'rk', 'addr_test1r', 'addr_test1s', 'addr_test1f',
      500, 2000000, 20000, 100, 1, 60000, 2000000, 'd8', now() + interval '1 hour')`;
  await sql`
    insert into calls (id, kind, api_id, op_id, rule_id, execution, verdict)
    values (${newId("call")}, 'preview', ${api.id}, 'getPrice', ${rule.id}, 'upstream_ok', 'pass')`;
  await seedCall(api.id, { kind: "probe" });
  await seedJob(api.id, { status: "expired" });
  await seedHealthEvent(api.id, "healthy", "down", new Date());
  return { api, op };
}

/** Rows left for this API in every table that references it, directly or through operations. */
async function remaining(apiId: string, opId: string): Promise<Record<string, number>> {
  const sql = getSql();
  const [row] = await sql<Record<string, number>[]>`
    select
      (select count(*)::int from apis where id = ${apiId}) as apis,
      (select count(*)::int from operations where api_id = ${apiId}) as operations,
      (select count(*)::int from rules where operation_id = ${opId}) as rules,
      (select count(*)::int from test_inputs where operation_id = ${opId}) as test_inputs,
      (select count(*)::int from onboard_steps where api_id = ${apiId}) as onboard_steps,
      (select count(*)::int from challenges where api_id = ${apiId}) as challenges,
      (select count(*)::int from messages where api_id = ${apiId}) as messages,
      (select count(*)::int from packs where api_id = ${apiId}) as packs,
      (select count(*)::int from pack_quotes where api_id = ${apiId}) as pack_quotes,
      (select count(*)::int from calls where api_id = ${apiId}) as calls,
      (select count(*)::int from jobs where api_id = ${apiId}) as jobs,
      (select count(*)::int from health_events where api_id = ${apiId}) as health_events`;
  return row;
}

describe("DELETE /api/apis/:apiId", () => {
  beforeEach(resetDb);

  it("needs a signed-in seller", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "intake");
    const res = await DELETE(del(api.id), ctx(api.id));
    expect(res.status).toBe(401);
  });

  it("refuses a cross-site request before touching anything", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "intake");
    const res = await DELETE(del(api.id, { cookie: cookieFor(seller), headers: { "sec-fetch-site": "cross-site" } }), ctx(api.id));
    expect(res.status).toBe(403);
    const res2 = await DELETE(del(api.id, { cookie: cookieFor(seller), headers: { origin: "https://evil.example" } }), ctx(api.id));
    expect(res2.status).toBe(403);
    const [still] = await getSql()`select 1 from apis where id = ${api.id}`;
    expect(still).toBeDefined();
  });

  it("answers 404 for another seller's API and leaves it alone", async () => {
    const owner = await seedSeller();
    const other = await seedSeller();
    const api = await seedApi(owner.id, "intake");
    const res = await DELETE(del(api.id, { cookie: cookieFor(other) }), ctx(api.id));
    expect(res.status).toBe(404);
    const [still] = await getSql()`select 1 from apis where id = ${api.id}`;
    expect(still).toBeDefined();
  });

  it("refuses a live API with a plain reason", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "live", { agentIdentifier: "agent_1" });
    const res = await DELETE(del(api.id, { cookie: cookieFor(seller) }), ctx(api.id));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "This API is on the Masumi registry. Retire it instead." });
  });

  it("refuses registering and retired APIs", async () => {
    const seller = await seedSeller();
    for (const state of ["registering", "retired"] as const) {
      const api = await seedApi(seller.id, state);
      const res = await DELETE(del(api.id, { cookie: cookieFor(seller) }), ctx(api.id));
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("This API reached the Masumi registry, so its records stay.");
    }
  });

  it("refuses an API whose register step started or that has an agent identifier", async () => {
    const seller = await seedSeller();
    const started = await seedApi(seller.id, "priced");
    await seedOnboardStep(started.id, "register", "failed");
    const named = await seedApi(seller.id, "priced", { agentIdentifier: "agent_2" });
    for (const api of [started, named]) {
      const res = await DELETE(del(api.id, { cookie: cookieFor(seller) }), ctx(api.id));
      expect(res.status).toBe(409);
    }
  });

  it("refuses an API buyers paid for", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "priced");
    const pack = await seedPack(api.id);
    await seedCreditToken(api.id, pack.id, { status: "pending", txHash: null });
    const res = await DELETE(del(api.id, { cookie: cookieFor(seller) }), ctx(api.id));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Buyers paid for this API, so its records stay.");
  });

  it("deletes an unfinished API and every row that depends on it, and nothing else", async () => {
    const seller = await seedSeller();
    const { api, op } = await seedUnfinished(seller.id);
    const keep = await seedUnfinished(seller.id);
    await getSql()`insert into messages (seller_id, author, body) values (${seller.id}, 'coworker', 'setup link')`;

    const res = await DELETE(del(api.id, { cookie: cookieFor(seller) }), ctx(api.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: api.id, name: "Weather API" });

    const gone = await remaining(api.id, op.id);
    for (const [table, count] of Object.entries(gone)) expect({ table, count }).toEqual({ table, count: 0 });
    const kept = await remaining(keep.api.id, keep.op.id);
    for (const [table, count] of Object.entries(kept)) expect({ table, count: count > 0 }).toEqual({ table, count: true });
    const [seller_msgs] = await getSql()<{ n: number }[]>`select count(*)::int as n from messages where api_id is null`;
    expect(seller_msgs.n).toBe(1);
  });

  it("answers 404 the second time", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "intake");
    expect((await DELETE(del(api.id, { cookie: cookieFor(seller) }), ctx(api.id))).status).toBe(200);
    expect((await DELETE(del(api.id, { cookie: cookieFor(seller) }), ctx(api.id))).status).toBe(404);
  });

  it("covers every table that references apis, directly or through another table (schema tripwire)", async () => {
    // Walks the foreign keys in the live schema: a new table pointing at an API's rows must join the delete order.
    const rows = await getSql()<{ table: string }[]>`
      with recursive dep(tbl) as (
        select 'apis'::regclass
        union
        select c.conrelid::regclass from pg_constraint c join dep on c.confrelid = dep.tbl
        where c.contype = 'f' and c.conrelid <> 'sellers'::regclass
      )
      select tbl::text as table from dep where tbl <> 'apis'::regclass`;
    expect(new Set(rows.map((r) => r.table))).toEqual(new Set(API_DELETE_ORDER.map((d) => d.table)));
  });
});
