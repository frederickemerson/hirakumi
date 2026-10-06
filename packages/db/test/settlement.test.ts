import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../src/testing";
import { deleteStaleDecisions, getOrCreateSettlementDecision, loadSettlementSignals } from "../src/settlement";

let db: TestDb;
beforeEach(async () => {
  db = await createTestDb();
  const sql = db.sql;
  await sql`insert into sellers (id, cardano_addr) values ('sel_a', 'addr_test1qseller')`;
  await sql`insert into apis (id, seller_id, name, origin, openapi_url, state, created_at)
            values ('api_a', 'sel_a', 'Price', 'https://p.example', 'https://p.example/openapi.json', 'live', now() - interval '10 days')`;
  await sql`insert into packs (id, api_id, calls, price_micros, escrow_price_micros) values ('pk_a', 'api_a', 100, 2000000, 1000000)`;
});
afterEach(async () => { await db.drop(); });

const fresh = (mode: "direct" | "escrow", reasons: string[], ttlSeconds = 600) =>
  async () => ({ apiId: "api_a", packId: "pk_a", mode, reasons, ttlSeconds });

describe("getOrCreateSettlementDecision", () => {
  it("keeps the first decision while it lives, without recomputing", async () => {
    const a = await getOrCreateSettlementDecision(db.sql, "k1", fresh("escrow", ["new seller"]));
    let computed = 0;
    const b = await getOrCreateSettlementDecision(db.sql, "k1", async () => { computed++; return fresh("direct", ["small pack"])(); });
    expect(a).toMatchObject({ mode: "escrow", reasons: ["new seller"] });
    expect(b).toEqual(a);
    expect(computed).toBe(0);
  });

  it("decides again once the decision expired", async () => {
    await getOrCreateSettlementDecision(db.sql, "k1", fresh("escrow", ["new seller"]));
    await db.sql`update settlement_decisions set expires_at = now() - interval '1 second'`;
    const b = await getOrCreateSettlementDecision(db.sql, "k1", fresh("direct", ["small pack", "proven seller"]));
    expect(b).toMatchObject({ mode: "direct", reasons: ["small pack", "proven seller"] });
  });

  it("gives every concurrent caller the same decision (first writer wins)", async () => {
    const out = await Promise.all(Array.from({ length: 40 }, (_, i) =>
      getOrCreateSettlementDecision(db.sql, "k2", fresh(i % 2 ? "direct" : "escrow", [`r${i}`]))));
    const first = out[0]!;
    for (const d of out) expect({ mode: d.mode, reasons: d.reasons }).toEqual({ mode: first.mode, reasons: first.reasons });
    expect((await db.sql`select count(*)::int as n from settlement_decisions`)[0]!.n).toBe(1);
  });

  it("deleteStaleDecisions removes only rows a day past expiry", async () => {
    await getOrCreateSettlementDecision(db.sql, "old", fresh("direct", ["small pack"]));
    await getOrCreateSettlementDecision(db.sql, "new", fresh("direct", ["small pack"]));
    await db.sql`update settlement_decisions set expires_at = now() - interval '2 days' where decision_key = 'old'`;
    expect(await deleteStaleDecisions(db.sql)).toBe(1);
    expect((await db.sql`select decision_key from settlement_decisions`).map((r) => r.decision_key)).toEqual(["new"]);
  });
});

describe("loadSettlementSignals", () => {
  const event = (to: string, from: string, ago: string) =>
    db.sql.unsafe(`insert into health_events (api_id, from_health, to_health, at) values ('api_a', '${from}', '${to}', now() - interval '${ago}')`);

  it("returns the listing time, the state at the window start, and the transitions inside it", async () => {
    await event("down", "healthy", "9 days");
    await event("healthy", "down", "6 days");
    await event("down", "healthy", "2 hours");
    const s = await loadSettlementSignals(db.sql, "api_a", 7);
    expect(s).not.toBeNull();
    expect(s!.now.getTime() - s!.listedAt.getTime()).toBeCloseTo(10 * 86_400_000, -4);
    expect(s!.now.getTime() - s!.windowStart.getTime()).toBeCloseTo(7 * 86_400_000, -4);
    expect(s!.startHealth).toBe("down");
    expect(s!.events.map((e) => e.to)).toEqual(["healthy", "down"]);
    expect(s!.events[0]!.at).toBeInstanceOf(Date);
  });

  it("starts the window at the listing when it is younger than the window, healthy by default", async () => {
    await db.sql`update apis set created_at = now() - interval '2 days'`;
    const s = await loadSettlementSignals(db.sql, "api_a", 7);
    expect(s!.windowStart.getTime()).toBe(s!.listedAt.getTime());
    expect(s!.startHealth).toBe("healthy");
    expect(s!.events).toEqual([]);
  });

  it("is null for an unknown API", async () => {
    expect(await loadSettlementSignals(db.sql, "api_nope", 7)).toBeNull();
  });
});
