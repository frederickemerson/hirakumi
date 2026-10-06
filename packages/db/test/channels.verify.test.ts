// Independent verifier: try to make the keyset pagination (finding G2) skip or repeat rows.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../src/testing";
import { allChannels, updateChannel } from "../src/channels";

let db: TestDb;
beforeEach(async () => {
  db = await createTestDb();
  await db.sql`insert into sellers (id, cardano_addr) values ('sel_a', 'addr_test1qseller')`;
  await db.sql`insert into apis (id, seller_id, name, origin, openapi_url, state) values ('api_a', 'sel_a', 'Price', 'https://p.example', 'https://p.example/openapi.json', 'live')`;
  await db.sql`insert into packs (id, api_id, calls, price_micros, escrow_price_micros) values ('pk_a', 'api_a', 100, 2000000, 1000000)`;
});
afterEach(async () => { await db.drop(); });

async function channel(id: string, createdAt: string, status = "locked") {
  await db.sql`insert into credit_tokens (id, api_id, pack_id, token_hash, status, remaining, payment_payload_hash)
    values (${"ct_" + id}, 'api_a', 'pk_a', md5(${id}), 'active', 100, md5(${"p" + id}))`;
  await db.sql`insert into pack_channels (channel_id, api_id, pack_id, credit_token_id, receipt_key, refund_address, seller_address, fee_address, fee_bps,
      price_micros, price_per_call_micros, max_calls, unsigned_allowance, contest_period_ms, close_fee_budget_lovelace, datum_cbor, status,
      lock_tx_hash, created_at)
    values (${id}, 'api_a', 'pk_a', ${"ct_" + id}, 'rk', 'refund', 'seller', 'fee', 300, 2000000, 20000, 100, 1, 180000, 700000, 'd8', ${status},
      md5(${"l" + id}), ${createdAt}::timestamptz)`;
}

describe("verify: allChannels pagination", () => {
  it("never skips or repeats rows whose created_at has sub-millisecond digits near a rounding edge (.xxx999, .xxx500)", async () => {
    const stamps = ["2026-01-01T00:00:00.123999Z", "2026-01-01T00:00:00.123500Z", "2026-01-01T00:00:00.123000Z", "2026-01-01T00:00:00.999999Z", "2026-01-01T00:00:01.000000Z"];
    const ids: string[] = [];
    let i = 0;
    for (const s of stamps) {
      for (let k = 0; k < 7; k++) {
        const id = (i++).toString(16).padStart(64, "0").replace(/^0/, String.fromCharCode(97 + ((k * 5) % 6)));
        ids.push(id);
        await channel(id, s);
      }
    }
    for (const limit of [1, 2, 3, 5, 7, 11]) {
      const seen: string[] = [];
      for await (const ch of allChannels(db.sql, ["locked"], limit)) seen.push(ch.channel_id);
      expect(seen.length, `limit ${limit}`).toBe(ids.length);
      expect(new Set(seen).size, `limit ${limit}`).toBe(ids.length);
    }
  });

  it("a row whose status changes mid-iteration does not make the loop skip unchanged rows", async () => {
    for (let k = 0; k < 9; k++) await channel(k.toString(16).padStart(64, "0"), "2026-01-01T00:00:00.5Z");
    const seen: string[] = [];
    for await (const ch of allChannels(db.sql, ["locked"], 2)) {
      seen.push(ch.channel_id);
      await updateChannel(db.sql, ch.channel_id, { status: "settled" }); // what watch() does to a channel it just handled
    }
    expect(seen).toHaveLength(9);
  });
});
