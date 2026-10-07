import { beforeEach, describe, expect, it } from "vitest";
import { newId, sha256Hex } from "@hirakumi/core";
import { getSql } from "@/lib/db";
import { saveSelfTestPack } from "@/lib/self-test-repo";
import { resetDb } from "@/test/db";
import { seedApi, seedCreditToken, seedPack, seedSeller } from "@/test/factories";
import { getAccount } from "./account";
import { getOverviewStats, listPackSales } from "./stats";
import { getPublicStatus } from "./status";

/** A credit token minted for a raw bearer token, as the gateway does on a purchase. */
async function tokenFor(apiId: string, packId: string, raw: string, payer: string | null = "addr_test1buyer") {
  const id = newId("ct");
  await getSql()`
    insert into credit_tokens (id, api_id, pack_id, token_hash, payer, status, remaining, payment_payload_hash, tx_hash)
    values (${id}, ${apiId}, ${packId}, ${sha256Hex(raw)}, ${payer}, 'active', 100, ${sha256Hex(id)}, ${sha256Hex(`tx${id}`)})`;
  return id;
}
const paidCall = (apiId: string, tokenId: string, verdict: "pass" | "fail") => getSql()`
  insert into calls (id, kind, credit_token_id, api_id, op_id, execution, verdict)
  values (${newId("call")}, 'credit', ${tokenId}, ${apiId}, 'getPrice', 'upstream_ok', ${verdict})`;

describe("self tests never count as sales, money received or pass rate", () => {
  beforeEach(resetDb);

  it("leaves out packs paid from the API's payout address, free tests and wallet self tests; counts real buyers", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "live");
    const pack = await seedPack(api.id, { priceMicros: "2000000" });
    const buyer = await tokenFor(api.id, pack.id, "hk_buyer");
    const ownAddress = await tokenFor(api.id, pack.id, "hk_own", seller.cardanoAddr);
    const free = await tokenFor(api.id, pack.id, "hk_free", "addr_test1demowallet");
    await getSql()`insert into try_tokens (id, api_id, status, token, token_hash, self_test_seller_id)
      values (${newId("try")}, ${api.id}, 'active', 'hk_free', ${sha256Hex("hk_free")}, ${seller.id})`;
    const wallet = await tokenFor(api.id, pack.id, "hk_wallet", "addr_test1someotherwalletofmine");
    await saveSelfTestPack(getSql(), { apiId: api.id, sellerId: seller.id, token: "hk_wallet", txHash: null, credits: 100 });
    await paidCall(api.id, buyer, "pass");
    for (const t of [ownAddress, free, wallet]) {
      await paidCall(api.id, t, "fail");
      await paidCall(api.id, t, "fail");
    }

    const stats = await getOverviewStats(getSql(), api.id);
    expect(stats).toMatchObject({ packSales: 1, packEarningsMicros: "2000000", callsDay: 1, passDay: 1, failDay: 0, passRate: 1 });
    expect((await listPackSales(getSql(), api.id)).map((s) => s.id)).toEqual([buyer]);
    const account = await getAccount(getSql(), seller.id);
    expect(account!.apis[0]).toMatchObject({ receivedMicros: "2000000", paidCallsDay: 1, passDay: 1, failDay: 0 });
    expect(await getPublicStatus(getSql(), api.id)).toMatchObject({ paidCalls: 1, passRatePct: 100 });
  });

  it("the showcase's demo purchases still count (a real buyer paid the seller)", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "live");
    const pack = await seedPack(api.id);
    await tokenFor(api.id, pack.id, "hk_demo", "addr_test1demowallet");
    await getSql()`insert into try_tokens (id, api_id, status, token, token_hash) values (${newId("try")}, ${api.id}, 'active', 'hk_demo', ${sha256Hex("hk_demo")})`;
    expect((await getOverviewStats(getSql(), api.id)).packSales).toBe(1);
  });

  it("received from packs: escrow counts what reaches the seller, not the locked amount; revoked and pending count nothing", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "live");
    const pack = await seedPack(api.id, { calls: 100, priceMicros: "2000000" });
    await seedCreditToken(api.id, pack.id, { status: "exhausted" }); // direct: 2.0
    await seedCreditToken(api.id, pack.id, { status: "revoked" }); // never
    await seedCreditToken(api.id, pack.id, { status: "pending", txHash: null }); // not yet
    const channel = async (tokenId: string, iou: number, paid: string | null) => getSql()`
      insert into pack_channels (channel_id, api_id, pack_id, credit_token_id, receipt_key, refund_address, seller_address, fee_address,
        fee_bps, price_micros, price_per_call_micros, max_calls, unsigned_allowance, contest_period_ms, close_fee_budget_lovelace, datum_cbor,
        status, lock_tx_hash, iou_accepted, seller_paid_micros)
      values (${sha256Hex(tokenId)}, ${api.id}, ${pack.id}, ${tokenId}, 'rk', 'addr_test1buyer', ${seller.cardanoAddr}, 'addr_test1fee',
        300, 2000000, 20000, 100, 1, 60000, 1000000, 'd8', ${paid ? "settled" : "locked"}, 'lock', ${iou}, ${paid})`;
    const open = await seedCreditToken(api.id, pack.id, { status: "active" });
    await channel(open.id, 10, null); // 10 signed calls x 0.02 less 3% = 0.194
    const settled = await seedCreditToken(api.id, pack.id, { status: "exhausted" });
    await channel(settled.id, 50, "970000"); // settled payout 0.97
    const stats = await getOverviewStats(getSql(), api.id);
    expect(stats.packSales).toBe(3);
    expect(stats.packEarningsMicros).toBe(String(2_000_000 + 194_000 + 970_000));
  });

  it("an escrow pack refunded to the API's own payout address is a self test", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "live");
    const pack = await seedPack(api.id);
    const t = await seedCreditToken(api.id, pack.id, { payer: null });
    await getSql()`
      insert into pack_channels (channel_id, api_id, pack_id, credit_token_id, receipt_key, refund_address, seller_address, fee_address,
        fee_bps, price_micros, price_per_call_micros, max_calls, unsigned_allowance, contest_period_ms, close_fee_budget_lovelace, datum_cbor,
        status, lock_tx_hash)
      values ('ch1', ${api.id}, ${pack.id}, ${t.id}, 'rk', ${seller.cardanoAddr}, ${seller.cardanoAddr}, 'addr_test1fee',
        300, 2000000, 20000, 100, 1, 60000, 1000000, 'd8', 'locked', 'lock')`;
    expect((await getOverviewStats(getSql(), api.id)).packSales).toBe(0);
  });
});
