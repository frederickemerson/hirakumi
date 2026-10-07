import { beforeEach, describe, expect, it } from "vitest";
import { getSql } from "@/lib/db";
import { resetDb } from "@/test/db";
import { seedApi, seedOperation, seedSeller } from "@/test/factories";
import { demoBudgetProblem, findTryPack, listTryOperations, tryEscrowStore } from "./try-repo";
import { ruleHash, sha256Hex, type RuleDefinition } from "@hirakumi/core";
import { seedPack } from "@/test/factories";

describe("listTryOperations", () => {
  beforeEach(resetDb);

  it("lists only enabled endpoints of a live API, with their input schema", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "live");
    const on = await seedOperation(api.id, { opId: "getPrice", enabled: true });
    await seedOperation(api.id, { opId: "hidden", path: "/hidden", enabled: false });
    await getSql()`update operations set input_schema = ${getSql().json({ type: "object", required: ["symbol"] })} where id = ${on.id}`;
    const ops = await listTryOperations(getSql(), api.id);
    expect(ops).toEqual([expect.objectContaining({ opId: "getPrice", method: "GET", inputSchema: { type: "object", required: ["symbol"] } })]);
  });

  it("is empty for an API that is not live", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "intake");
    await seedOperation(api.id, { enabled: true });
    expect(await listTryOperations(getSql(), api.id)).toEqual([]);
  });
});

describe("demo pack budget", () => {
  beforeEach(resetDb);

  let n = 0;
  async function demo(remaining: number, status = "active") {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "live");
    const pack = await seedPack(api.id);
    n += 1;
    const token = { id: `ct_demo${n}`, raw: `hk_demo_${n}` };
    await getSql()`
      insert into credit_tokens (id, api_id, pack_id, token_hash, status, remaining, payment_payload_hash, tx_hash)
      values (${token.id}, ${api.id}, ${pack.id}, ${sha256Hex(token.raw)}, ${status}, ${remaining}, ${"pp" + n}, ${"tx" + n})`;
    return { api, token };
  }
  const seedTokenCall = (apiId: string, tokenId: string, i: number) => getSql()`
    insert into calls (id, kind, credit_token_id, api_id, op_id, execution, verdict)
    values (${`call_${tokenId}_${i}`}, 'credit', ${tokenId}, ${apiId}, 'getPrice', 'upstream_ok', 'pass')`;

  /** A pack the gateway bought live for this API, as POST /internal/demo/buy-pack stores it. */
  const liveRow = (apiId: string, raw: string, ago: string, status = "active") => getSql()`
    insert into try_tokens (id, api_id, status, token, token_hash, tx_hash, credits, created_at)
    values (${`try_${raw}`}, ${apiId}, ${status}, ${raw}, ${sha256Hex(raw)}, ${"live_" + raw}, 100, now() - ${ago}::interval)`;

  it("uses the newest live pack with credits from try_tokens, ahead of the TRY_CREDIT_TOKENS one", async () => {
    const { api, token } = await demo(42);
    await liveRow(api.id, token.raw, "1 minute");
    const pack = await findTryPack(getSql(), api.id, "hk_env_fallback");
    expect(pack).toMatchObject({ token: token.raw, creditTokenId: token.id, remaining: 42, pending: false, txHash: `live_${token.raw}`, source: "live" });
  });

  it("skips a live pack that is used up and falls back to the env token", async () => {
    const { api, token } = await demo(0, "exhausted");
    await liveRow(api.id, token.raw, "1 minute");
    expect(await findTryPack(getSql(), api.id, undefined)).toBeNull();
    const envToken = "hk_env_token";
    await getSql()`
      insert into credit_tokens (id, api_id, pack_id, token_hash, status, remaining, payment_payload_hash, tx_hash)
      select 'ct_env', ${api.id}, pack_id, ${sha256Hex(envToken)}, 'active', 7, 'pp_env', 'tx_env' from credit_tokens where id = ${token.id}`;
    expect(await findTryPack(getSql(), api.id, envToken)).toMatchObject({ token: envToken, remaining: 7, source: "env" });
    // Receipts stay readable after the credits run out.
    expect(await findTryPack(getSql(), api.id, undefined, { withCredits: false })).toMatchObject({ token: token.raw, remaining: 0 });
  });

  it("a settling pack is usable and says so; a buying or unsettled attempt is not a pack", async () => {
    const { api, token } = await demo(100, "pending");
    await liveRow(api.id, token.raw, "1 minute");
    expect(await findTryPack(getSql(), api.id, undefined)).toMatchObject({ pending: true, remaining: 100 });
    const other = await demo(100);
    await getSql()`insert into try_tokens (id, api_id, status) values ('try_buying', ${other.api.id}, 'buying')`;
    expect(await findTryPack(getSql(), other.api.id, undefined)).toBeNull();
  });

  it("never returns another API's pack or token", async () => {
    const a = await demo(10);
    const b = await demo(10);
    await liveRow(a.api.id, a.token.raw, "1 minute");
    expect(await findTryPack(getSql(), b.api.id, a.token.raw)).toBeNull();
  });

  it("allows paid tries until the hourly cap of calls made with the demo token", async () => {
    const { api, token } = await demo(90);
    expect(await demoBudgetProblem(getSql(), token.raw, 3)).toBeNull();
    for (let i = 0; i < 3; i++) await seedTokenCall(api.id, token.id, i);
    expect(await demoBudgetProblem(getSql(), token.raw, 3)).toMatch(/this hour/);
  });

  it("explains an empty pack", async () => {
    const { token } = await demo(0, "exhausted");
    expect(await demoBudgetProblem(getSql(), token.raw, 3)).toMatch(/used up/);
  });
});

describe("escrow live packs", () => {
  beforeEach(resetDb);

  /** A live escrow pack as the gateway stores it: credit token, its channel, and the demo wallet's IOU key. */
  async function escrowPack(channelStatus = "locked") {
    const sql = getSql();
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "live");
    const pack = await seedPack(api.id);
    const raw = "hk_escrow_1";
    const channelId = "cd".repeat(32);
    await sql`
      insert into credit_tokens (id, api_id, pack_id, token_hash, status, remaining, payment_payload_hash, tx_hash)
      values ('ct_esc', ${api.id}, ${pack.id}, ${sha256Hex(raw)}, 'active', 100, 'pp_esc', 'tx_esc')`;
    await sql`
      insert into pack_channels (channel_id, api_id, pack_id, credit_token_id, receipt_key, refund_address, seller_address, fee_address, fee_bps,
        price_micros, price_per_call_micros, max_calls, unsigned_allowance, contest_period_ms, close_fee_budget_lovelace, datum_cbor, status, lock_tx_hash)
      values (${channelId}, ${api.id}, ${pack.id}, 'ct_esc', 'rk', 'addr_test1r', 'addr_test1s', 'addr_test1f', 300,
        2000000, 20000, 100, 1, 180000, 700000, 'd8', ${channelStatus}, 'tx_esc')`;
    await sql`
      insert into try_tokens (id, api_id, status, token, token_hash, credits, channel_id, iou_secret, rule_hash, iou_last)
      values ('try_esc', ${api.id}, 'active', ${raw}, ${sha256Hex(raw)}, 100, ${channelId}, ${"11".repeat(32)}, 'sha256:x', '3.sig')`;
    return { api, channelId };
  }

  it("returns the channel and IOU key with an open escrow pack", async () => {
    const { api, channelId } = await escrowPack();
    expect((await findTryPack(getSql(), api.id, undefined))?.channel).toEqual({
      tryId: "try_esc", channelId, secretKey: "11".repeat(32), ruleHash: "sha256:x", lastIou: "3.sig",
    });
  });

  it("skips a pack whose channel is closing or that the demo wallet disputed", async () => {
    const { api } = await escrowPack("close_requested");
    expect(await findTryPack(getSql(), api.id, undefined)).toBeNull();
    await getSql()`update pack_channels set status = 'locked'`;
    await getSql()`update try_tokens set disputed = true`;
    expect(await findTryPack(getSql(), api.id, undefined)).toBeNull();
  });

  it("counts checked passes atomically and only ever moves the kept IOU forward", async () => {
    await escrowPack();
    const store = tryEscrowStore(getSql());
    expect(await Promise.all([store.countPass("try_esc"), store.countPass("try_esc"), store.countPass("try_esc")])).toEqual(expect.arrayContaining([1, 2, 3]));
    expect(await store.verified("try_esc")).toBe(3);
    await store.saveIou("try_esc", 5, "5.new");
    await store.saveIou("try_esc", 4, "4.older");
    const [row] = await getSql()<{ iouSigned: number; iouLast: string }[]>`select iou_signed, iou_last from try_tokens where id = 'try_esc'`;
    expect(row).toEqual({ iouSigned: 5, iouLast: "5.new" });
  });

  it("finds the promise only when its definition hashes to the lock's rule hash", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "live");
    const op = await seedOperation(api.id, { enabled: true });
    const def = { version: 1, status: { min: 200, max: 299 }, contentType: "application/json", schema: { type: "object" } } as RuleDefinition;
    await getSql()`insert into rules (id, operation_id, version, definition, hash) values ('r_ok', ${op.id}, 1, ${getSql().json(def as never)}, ${ruleHash(def)})`;
    await getSql()`insert into rules (id, operation_id, version, definition, hash) values ('r_bad', ${op.id}, 2, ${getSql().json(def as never)}, 'sha256:forged')`;
    const store = tryEscrowStore(getSql());
    expect(await store.rule(ruleHash(def))).toEqual(def);
    expect(await store.rule("sha256:forged")).toBeNull();
  });
});

describe("reserveTryCall: the hourly budget is reserved before the call", () => {
  beforeEach(resetDb);

  async function pack() {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "live");
    const p = await seedPack(api.id);
    await getSql()`insert into credit_tokens (id, api_id, pack_id, token_hash, status, remaining, payment_payload_hash)
      values ('ct_budget', ${api.id}, ${p.id}, ${sha256Hex("hk_budget")}, 'active', 1000, 'pp_budget')`;
  }

  it("50 tries at once get exactly the 30 slots of the hour", async () => {
    await pack();
    const { reserveTryCall } = await import("./try-repo");
    const slots = await Promise.all(Array.from({ length: 50 }, () => reserveTryCall(getSql(), "hk_budget", 30)));
    expect(slots.filter((s) => s.ok)).toHaveLength(30);
    expect(slots.find((s) => !s.ok)).toMatchObject({ problem: expect.stringMatching(/this hour/) });
  });

  it("a released slot (the call never reached the gateway) is free again", async () => {
    await pack();
    const { reserveTryCall } = await import("./try-repo");
    const a = await reserveTryCall(getSql(), "hk_budget", 1);
    expect((await reserveTryCall(getSql(), "hk_budget", 1)).ok).toBe(false);
    if (a.ok) await a.release();
    expect((await reserveTryCall(getSql(), "hk_budget", 1)).ok).toBe(true);
  });

  it("a used-up pack gets no slot", async () => {
    await pack();
    await getSql()`update credit_tokens set remaining = 0, status = 'exhausted'`;
    const { reserveTryCall } = await import("./try-repo");
    expect(await reserveTryCall(getSql(), "hk_budget", 30)).toEqual({ ok: false, problem: expect.stringMatching(/used up/) });
  });
});
