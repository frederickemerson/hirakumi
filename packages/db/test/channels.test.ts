import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../src/testing";
import {
  allChannels, deleteStaleQuotes, expireUnseenLocks, getChannel, getOrCreateQuote, listChannels, markChannelLocked, reopenChannel, revertChannelToPending,
  updateChannel,
} from "../src/channels";

let db: TestDb;
beforeEach(async () => {
  db = await createTestDb();
  const sql = db.sql;
  await sql`insert into sellers (id, cardano_addr) values ('sel_a', 'addr_test1qseller')`;
  await sql`insert into apis (id, seller_id, name, origin, openapi_url, state) values ('api_a', 'sel_a', 'Price', 'https://p.example', 'https://p.example/openapi.json', 'live')`;
  await sql`insert into packs (id, api_id, calls, price_micros, escrow_price_micros) values ('pk_a', 'api_a', 100, 2000000, 1000000)`;
});
afterEach(async () => { await db.drop(); });

/** `n` channels in `status`, all created in the same instant (so only the channel id orders them). */
async function channels(n: number, status: string, createdAt = "now()", prefix = "c") {
  await db.sql.unsafe(`
    insert into credit_tokens (id, api_id, pack_id, token_hash, status, remaining, payment_payload_hash)
    select 'ct_${prefix}' || g, 'api_a', 'pk_a', md5('${prefix}t' || g), 'pending', 100, md5('${prefix}p' || g) from generate_series(1, ${n}) g`);
  await db.sql.unsafe(`
    insert into pack_channels (channel_id, api_id, pack_id, credit_token_id, receipt_key, refund_address, seller_address, fee_address, fee_bps,
      price_micros, price_per_call_micros, max_calls, unsigned_allowance, contest_period_ms, close_fee_budget_lovelace, datum_cbor, status,
      lock_tx_hash, created_at)
    select md5('${prefix}c' || g) || md5('${prefix}d' || g), 'api_a', 'pk_a', 'ct_${prefix}' || g, 'rk', 'refund', 'seller', 'fee', 300,
      2000000, 20000, 100, 1, 180000, 700000, 'd8', '${status}', md5('${prefix}l' || g) || md5('${prefix}m' || g), ${createdAt}
    from generate_series(1, ${n}) g`);
}

describe("listChannels / allChannels (finding G2)", () => {
  it("pages by (created_at, channel_id), even when far more rows than a page share one created_at", async () => {
    await channels(25, "locked", "now() - interval '1 day' + interval '0.000123 seconds'", "a"); // sub-millisecond created_at
    await channels(5, "locked", "now()", "b");
    await channels(3, "pending", "now()", "p");
    const first = await listChannels(db.sql, ["locked"], { limit: 10 });
    expect(first).toHaveLength(10);
    const seen: string[] = [];
    for await (const ch of allChannels(db.sql, ["locked"], 10)) seen.push(ch.channel_id);
    expect(seen).toHaveLength(30);
    expect(new Set(seen).size).toBe(30);
    expect(seen.slice(0, 10)).toEqual(first.map((c) => c.channel_id));
    expect((await listChannels(db.sql, ["locked", "pending"])).length).toBe(33); // default page: 200
  });
});

describe("expireUnseenLocks (finding G2)", () => {
  it("refuses old pending channels whose lock was never seen; leaves fresh ones and verified-then-rolled-back ones", async () => {
    await channels(3, "pending", "now() - interval '2 hours'", "o");
    await channels(2, "pending", "now()", "n");
    const [rolledBack] = await listChannels(db.sql, ["pending"], { limit: 1 });
    await db.sql`update pack_channels set lock_output_index = 1 where channel_id = ${rolledBack!.channel_id}`;
    const refused = await expireUnseenLocks(db.sql, 3600);
    expect(refused).toHaveLength(2);
    expect(refused).not.toContain(rolledBack!.channel_id);
    for (const id of refused) expect(await getChannel(db.sql, id)).toMatchObject({ status: "refused", refused_reason: "lock_never_seen" });
    expect((await listChannels(db.sql, ["pending"])).length).toBe(3);
    expect(await expireUnseenLocks(db.sql, 3600)).toEqual([]);
  });
});

describe("rollback helpers (finding G4)", () => {
  it("revertChannelToPending clears the on-chain state; reopenChannel takes a closing channel back to locked", async () => {
    await channels(1, "pending", "now()", "r");
    const [ch] = await listChannels(db.sql, ["pending"]);
    const id = ch!.channel_id;
    await markChannelLocked(db.sql, id, 1);
    await updateChannel(db.sql, id, { status: "closing", close_tx_hash: "ab", raise_tx_hashes: ["cd"], onchain_accepted: 2, contest_end_ms: "5", utxo_tx_hash: "cd", utxo_output_index: 0 });
    expect(await reopenChannel(db.sql, id, { txHash: ch!.lock_tx_hash, index: 1 })).toBe(true);
    expect(await getChannel(db.sql, id)).toMatchObject({
      status: "locked", utxo_tx_hash: ch!.lock_tx_hash, utxo_output_index: 1, close_tx_hash: null, raise_tx_hashes: [], onchain_accepted: null, contest_end_ms: null,
    });
    expect(await reopenChannel(db.sql, id, { txHash: "x", index: 0 })).toBe(false); // only from closing
    expect(await revertChannelToPending(db.sql, id)).toBe(true);
    expect(await getChannel(db.sql, id)).toMatchObject({ status: "pending", lock_output_index: 1, utxo_tx_hash: null, utxo_output_index: null });
    expect(await revertChannelToPending(db.sql, id)).toBe(false);
    await updateChannel(db.sql, id, { status: "settled" });
    expect(await revertChannelToPending(db.sql, id)).toBe(false); // never un-settles
  });
});

describe("deleteStaleQuotes", () => {
  it("deletes only unpaid quotes a day past their expiry", async () => {
    const quote = (key: string, expires: string, consumed: string) => db.sql.unsafe(`
      insert into pack_quotes (quote_key, channel_id, api_id, pack_id, receipt_key, refund_address, seller_address, fee_address, fee_bps,
        price_micros, price_per_call_micros, max_calls, unsigned_allowance, contest_period_ms, close_fee_budget_lovelace, datum_cbor, expires_at, consumed_at)
      values ('${key}', md5('${key}') || md5('x${key}'), 'api_a', 'pk_a', 'rk', 'refund', 'seller', 'fee', 300, 2000000, 20000, 100, 1, 180000, 700000, 'd8', ${expires}, ${consumed})`);
    await quote("old", "now() - interval '2 days'", "null");
    await quote("old_paid", "now() - interval '2 days'", "now() - interval '2 days'");
    await quote("recent", "now() - interval '1 hour'", "null");
    expect(await deleteStaleQuotes(db.sql)).toBe(1);
    expect((await db.sql<{ quote_key: string }[]>`select quote_key from pack_quotes order by quote_key`).map((r) => r.quote_key)).toEqual(["old_paid", "recent"]);
  });
});

describe("getOrCreateQuote under concurrency", () => {
  const fresh = (i: number) => () => ({
    quote_key: "q1", channel_id: `${i}`.padStart(64, "0"), api_id: "api_a", pack_id: "pk_a", receipt_key: "rk", refund_address: "refund",
    seller_address: "seller", fee_address: "fee", fee_bps: 300, price_micros: "2000000", price_per_call_micros: "20000", max_calls: 100,
    unsigned_allowance: 1, contest_period_ms: "180000", close_fee_budget_lovelace: "700000", datum_cbor: `d8${i}`, ttlSeconds: 600,
  });

  it("gives every concurrent 402 for one key the same quote (a later insert never overwrites a live one)", async () => {
    const out = await Promise.all(Array.from({ length: 30 }, (_, i) => getOrCreateQuote(db.sql, "q1", fresh(i))));
    expect(new Set(out.map((q) => q.channel_id)).size).toBe(1);
  });

  it("replaces a consumed or expired quote", async () => {
    const a = await getOrCreateQuote(db.sql, "q1", fresh(1));
    await db.sql`update pack_quotes set consumed_at = now() where quote_key = 'q1'`;
    const b = await getOrCreateQuote(db.sql, "q1", fresh(2));
    expect(b.channel_id).not.toBe(a.channel_id);
    await db.sql`update pack_quotes set expires_at = now() - interval '1 second' where quote_key = 'q1'`;
    expect((await getOrCreateQuote(db.sql, "q1", fresh(3))).channel_id).toBe(fresh(3)().channel_id);
  });
});
