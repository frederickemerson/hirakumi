// Money invariants under concurrency: a credit is used exactly when a 200 carrying a kept promise is sent,
// one payment buys at most one pack, and escrow channels never serve past the buyer's signatures.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { newReceiptKey, signReceipt, verifyReceipt } from "@hirakumi/escrow";
import { sha256Hex } from "@hirakumi/core";
import { getChannel } from "@hirakumi/db";
import type { PackEscrowConfig } from "../../apps/gateway/src/config";
import { forgetSettlementSignals } from "../../apps/gateway/src/settlement";
import {
  BUYER, FEE, FakeEscrowChain, SELLER, anotherBase, insertActiveToken, makeHarness, offerOf, passingBody, paymentHeader, scale, seedLiveApi,
  serve, startHostileSeller, tally, txHash, type Harness,
} from "./kit";

const ESCROW: PackEscrowConfig = {
  feeAddress: FEE, feeBps: 300, closerVkh: "c1".repeat(28), contestPeriodMs: 180_000, closeFeeBudgetLovelace: 700_000,
  operatorMnemonic: null, leaseSeconds: 30, raiseMarginMs: 60_000,
};

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!().catch(() => {}); });

/** Runs `jobs` with at most `width` in flight. */
async function pool<T>(jobs: (() => Promise<T>)[], width: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, async () => {
    while (i < jobs.length) { const k = i++; out[k] = await jobs[k]!(); }
  }));
  return out;
}

async function directSetup() {
  const h = await makeHarness({ config: { upstreamTimeoutMs: 2_000 } });
  cleanups.push(() => h.close());
  const seller = await startHostileSeller();
  cleanups.push(() => seller.close());
  const s = await seedLiveApi(h.sql, seller.origin);
  const srv = await serve(h.app);
  cleanups.push(() => srv.close());
  return { h, seller, s, srv };
}

describe("credits: used == kept promises, exactly, under concurrent chaos", () => {
  it("many tokens, a seller that randomly passes, fails, 500s, drops the socket or is slow", async () => {
    const { h, seller, s, srv } = await directSetup();
    seller.setReply(async () => {
      const x = Math.random();
      if (x < 0.45) return {};
      if (x < 0.6) return { body: "{}" };
      if (x < 0.7) return { status: 500, body: '{"e":1}' };
      if (x < 0.8) return "destroy";
      if (x < 0.9) return { headers: { "content-type": "text/html" }, body: "<html>" };
      await new Promise((r) => setTimeout(r, 30));
      return {};
    });
    const tokens = await Promise.all(Array.from({ length: 40 }, async () => {
      const initial = 1 + Math.floor(Math.random() * 25);
      return { ...(await insertActiveToken(h.sql, s, initial)), initial, ok: 0 };
    }));
    const N = scale(3_000, 20_000);
    const statuses: number[] = [];
    await pool(Array.from({ length: N }, () => async () => {
      const t = tokens[Math.floor(Math.random() * tokens.length)]!;
      const r = await srv.req(`/a/${s.apiId}/x/getPrice?symbol=ADA`, { headers: { authorization: `Bearer ${t.token}` } });
      statuses.push(r.status);
      if (r.status === 200) t.ok += 1;
    }), 200);
    const bad: string[] = [];
    for (const t of tokens) {
      const [row] = await h.sql<{ remaining: number; status: string }[]>`select remaining, status from credit_tokens where id = ${t.id}`;
      const [{ n }] = await h.sql<{ n: number }[]>`select count(*)::int as n from calls where credit_token_id = ${t.id} and verdict = 'pass'`;
      const used = t.initial - row!.remaining;
      if (used !== t.ok || used !== n || row!.remaining < 0) bad.push(`${t.id}: initial=${t.initial} used=${used} 200s=${t.ok} passRows=${n} remaining=${row!.remaining}`);
      if ((row!.remaining === 0) !== (row!.status === "exhausted")) bad.push(`${t.id}: remaining=${row!.remaining} status=${row!.status}`);
    }
    const t = tally(statuses);
    // 429: a token past 20 failed calls in a minute is turned away before any credit is reserved.
    expect(Object.keys(t).every((k) => ["200", "402", "422", "429", "502"].includes(k)), JSON.stringify(t)).toBe(true);
    expect(bad).toEqual([]);
  });

  it("last-credit race on 100 tokens at once: exactly one 200 per token", async () => {
    const { h, s, srv } = await directSetup();
    const tokens = await Promise.all(Array.from({ length: 100 }, () => insertActiveToken(h.sql, s, 1)));
    const rs = await Promise.all(tokens.flatMap((t) => Array.from({ length: 12 }, () =>
      srv.req(`/a/${s.apiId}/x/getPrice?symbol=ADA`, { headers: { authorization: `Bearer ${t.token}` } }).then((r) => `${t.id}:${r.status}`))));
    const per = tally(rs.filter((x) => x.endsWith(":200")).map((x) => x.split(":")[0]!));
    expect(Object.keys(per)).toHaveLength(100);
    expect(Object.values(per).every((n) => n === 1)).toBe(true);
    const [{ left }] = await h.sql<{ left: number }[]>`select coalesce(sum(remaining), 0)::int as left from credit_tokens where status <> 'exhausted' or remaining <> 0`;
    expect(left).toBe(0);
  });

  it("a token used on another API never spends (cross-API replay of a bearer)", async () => {
    const { h, s, srv } = await directSetup();
    const other = await seedLiveApi(h.sql, h.stub.origin, { pathPrefix: anotherBase() });
    const { token, id } = await insertActiveToken(h.sql, s, 5);
    const rs = await Promise.all(Array.from({ length: 50 }, () =>
      srv.req(`/a/${other.apiId}/x/getPrice?symbol=ADA`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.status)));
    expect(tally(rs)).toEqual({ 401: 50 });
    const [row] = await h.sql<{ remaining: number }[]>`select remaining from credit_tokens where id = ${id}`;
    expect(row!.remaining).toBe(5);
  });
});

describe("payments: one transaction buys at most one pack, under concurrency", () => {
  it("one tx raced 90x across 3 APIs and 2 packs each (fresh nonces): one token, one settle", async () => {
    const { h, srv } = await directSetup();
    const apis = [h.seeded, ...(await Promise.all([1, 2].map(() => seedLiveApi(h.sql, h.stub.origin, { pathPrefix: anotherBase() }))))];
    const routes: { path: string }[] = [];
    for (const a of apis) {
      const pk2 = `pk_${randomBytes(5).toString("hex")}`;
      await h.sql`insert into packs (id, api_id, calls, price_micros, escrow_price_micros) values (${pk2}, ${a.apiId}, 10, 1000000, 1000000)`;
      h.registry.invalidate(a.apiId);
      routes.push({ path: `/a/${a.apiId}/packs/${a.packId}` }, { path: `/a/${a.apiId}/packs/${pk2}` });
    }
    const offers = await Promise.all(routes.map(async (r) => {
      const o = await offerOf(await srv.req(r.path, { method: "POST" }));
      return { ...r, required: o!, accepted: o!.accepts[0]! };
    }));
    const rs = await Promise.all(Array.from({ length: 90 }, (_, i) => {
      const o = offers[i % offers.length]!;
      return srv.req(o.path, { method: "POST", headers: { "payment-signature": paymentHeader(o.required, o.accepted, "tx-double", String(i)), "x-hirakumi-recovery": sha256Hex("s") } })
        .then((r) => r.status);
    }));
    const t = tally(rs);
    expect(t[200]).toBe(1);
    expect(h.facilitator.settleCalls).toBe(1);
    const [{ n }] = await h.sql<{ n: number }[]>`select count(*)::int as n from credit_tokens`;
    expect(n).toBe(1);
    expect(Object.keys(t).every((k) => k === "200" || k === "409"), JSON.stringify(t)).toBe(true);
  });

  it("a paid retry replayed to another pack's URL never matches its offer (no verify, no settle)", async () => {
    const { h, srv } = await directSetup();
    const pk2 = `pk_${randomBytes(5).toString("hex")}`;
    await h.sql`insert into packs (id, api_id, calls, price_micros, escrow_price_micros) values (${pk2}, ${h.seeded.apiId}, 10, 2000000, 1000000)`;
    h.registry.invalidate(h.seeded.apiId);
    const path1 = `/a/${h.seeded.apiId}/packs/${h.seeded.packId}`;
    const o = (await offerOf(await srv.req(path1, { method: "POST" })))!;
    const sig = paymentHeader(o, o.accepts[0]!, "tx-replay");
    // Same price, other pack: the offer differs only in extra.packId/calls.
    const before = h.facilitator.verifyCalls;
    const r = await srv.req(`/a/${h.seeded.apiId}/packs/${pk2}`, { method: "POST", headers: { "payment-signature": sig } });
    expect(r.status).toBe(402);
    expect(h.facilitator.verifyCalls).toBe(before);
    expect(h.facilitator.settleCalls).toBe(0);
  });
});

describe("hybrid / escrow: decisions, quotes and channels under races", () => {
  async function escrowSetup(mode: "escrow" | "hybrid", allowance = 3) {
    const chain = new FakeEscrowChain(true);
    const h = await makeHarness({ config: { packMode: mode, packEscrow: ESCROW, upstreamTimeoutMs: 2_000 }, escrowChain: chain, facilitatorMethods: ["default", "script"] });
    cleanups.push(() => h.close());
    const seller = await startHostileSeller();
    cleanups.push(() => seller.close());
    await h.sql`update sellers set cardano_addr = ${SELLER} where id = ${h.seeded.sellerId}`;
    await h.sql`update apis set origin = ${seller.origin}, created_at = now() - interval '30 days' where id = ${h.seeded.apiId}`;
    await h.sql`update packs set price_micros = 2000000, unsigned_allowance = ${allowance} where id = ${h.seeded.packId}`;
    h.registry.invalidate(h.seeded.apiId);
    forgetSettlementSignals(h.sql);
    const srv = await serve(h.app);
    cleanups.push(() => srv.close());
    return { h, chain, seller, srv, packPath: `/a/${h.seeded.apiId}/packs/${h.seeded.packId}`, callPath: `/a/${h.seeded.apiId}/x/getPrice?symbol=ADA` };
  }
  const keyHeaders = (k: { publicKey: string }, refund = BUYER) => ({ "x-hirakumi-receipt-key": k.publicKey, "x-hirakumi-refund-address": refund });

  it("200 concurrent 402s for one buyer: one decision row, one quote, identical offers", async () => {
    const { h, srv, packPath } = await escrowSetup("hybrid");
    const k = newReceiptKey();
    const rs = await Promise.all(Array.from({ length: 200 }, () => srv.req(packPath, { method: "POST", headers: keyHeaders(k) })));
    const offers = new Set(await Promise.all(rs.map(async (r) => JSON.stringify((await offerOf(r))?.accepts[0]))));
    expect(tally(rs.map((r) => r.status))).toEqual({ 402: 200 });
    expect(offers.size).toBe(1);
    const [{ d }] = await h.sql<{ d: number }[]>`select count(*)::int as d from settlement_decisions`;
    const [{ q }] = await h.sql<{ q: number }[]>`select count(*)::int as q from pack_quotes`;
    expect(d).toBe(1);
    expect(q).toBe(1);
  });

  it("one escrow quote paid by 20 different transactions at once: one channel, one settle, one usable token", async () => {
    const { h, chain, srv, packPath } = await escrowSetup("escrow");
    const k = newReceiptKey();
    const o = (await offerOf(await srv.req(packPath, { method: "POST", headers: keyHeaders(k) })))!;
    const accepted = o.accepts[0]!;
    const txs = Array.from({ length: 20 }, (_, i) => `lock-race-${i}-${randomBytes(4).toString("hex")}`);
    for (const t of txs) chain.putLock(txHash(t), String((accepted.extra as { datum: string }).datum));
    const rs = await Promise.all(txs.map((t) => srv.req(packPath, { method: "POST", headers: { ...keyHeaders(k), "payment-signature": paymentHeader(o, accepted, t) } })));
    const t = tally(rs.map((r) => r.status));
    expect(t[200]).toBe(1);
    expect(h.facilitator.settleCalls).toBe(1);
    const [{ c }] = await h.sql<{ c: number }[]>`select count(*)::int as c from pack_channels`;
    expect(c).toBe(1);
    const [{ a }] = await h.sql<{ a: number }[]>`select count(*)::int as a from credit_tokens where status = 'active'`;
    expect(a).toBe(1);
  });

  it("IOU gate under concurrent chaos: never more than the allowance unsigned, IOUs only rise, 200s == passes == credits used", async () => {
    const allowance = 3;
    const { h, chain, seller, srv, packPath, callPath } = await escrowSetup("escrow", allowance);
    seller.setReply(() => (Math.random() < 0.7 ? {} : { body: "{}" }));
    const k = newReceiptKey();
    const o = (await offerOf(await srv.req(packPath, { method: "POST", headers: keyHeaders(k) })))!;
    const accepted = o.accepts[0]!;
    const channelId = String((accepted.extra as { channelId: string }).channelId);
    const lock = `lock-${randomBytes(6).toString("hex")}`;
    chain.putLock(txHash(lock), String((accepted.extra as { datum: string }).datum));
    const bought = await srv.req(packPath, { method: "POST", headers: { ...keyHeaders(k), "payment-signature": paymentHeader(o, accepted, lock) } });
    expect(bought.status).toBe(200);
    const token = String(bought.json.token);
    const other = newReceiptKey();
    // A second, unrelated buyer's channel id to forge IOUs against.
    const foreignChannel = randomBytes(32).toString("hex");
    let ok = 0;
    let lastIou = 0;
    const rounds = scale(25, 150);
    for (let round = 0; round < rounds; round++) {
      const ch = (await getChannel(h.sql, channelId))!;
      expect(ch.status).toBe("locked");
      const served = ch.passes_served;
      const jobs = Array.from({ length: 12 }, () => {
        const x = Math.random();
        let iou: string | undefined;
        if (x < 0.35) { const n = Math.floor(Math.random() * (served + 3)); iou = `${n}.${signReceipt(k.secretKey, channelId, n)}`; }
        else if (x < 0.45) iou = `${served}.${signReceipt(other.secretKey, channelId, served)}`; // wrong key
        else if (x < 0.55) iou = `${served}.${signReceipt(k.secretKey, foreignChannel, served)}`; // other channel
        else if (x < 0.6) iou = `${served}.${"ab".repeat(64)}`; // garbage signature
        else if (x < 0.62) iou = `-1.${"00".repeat(64)}`;
        const headers: Record<string, string> = { authorization: `Bearer ${token}` };
        if (iou) headers["x-hirakumi-iou"] = iou;
        return srv.req(callPath, { headers }).then((r) => r.status);
      });
      const st = await Promise.all(jobs);
      ok += st.filter((s) => s === 200).length;
      const after = (await getChannel(h.sql, channelId))!;
      expect(after.iou_accepted).toBeGreaterThanOrEqual(lastIou);
      lastIou = after.iou_accepted;
      expect(after.passes_served - after.iou_accepted).toBeLessThanOrEqual(allowance);
      if (after.iou_accepted > 0) expect(verifyReceipt(k.publicKey, channelId, after.iou_accepted, after.iou_signature!)).toBe(true);
      expect(st.every((s) => [200, 401, 402, 422].includes(s)), JSON.stringify(tally(st))).toBe(true);
      if (after.passes_served >= after.max_calls) break;
    }
    const final = (await getChannel(h.sql, channelId))!;
    const [tok] = await h.sql<{ remaining: number }[]>`select remaining from credit_tokens where id = ${final.credit_token_id}`;
    expect(final.passes_served).toBe(ok);
    expect(final.max_calls - tok!.remaining).toBe(ok);
    const [{ leases }] = await h.sql<{ leases: number }[]>`select count(*)::int as leases from channel_leases`;
    expect(leases).toBe(0);
  });

  it("close requested while 40 calls are in flight: nothing is served after the 202", async () => {
    const { h, chain, srv, packPath, callPath, seller } = await escrowSetup("escrow", 100);
    seller.setReply(async () => { await new Promise((r) => setTimeout(r, Math.random() * 40)); return {}; });
    const k = newReceiptKey();
    const o = (await offerOf(await srv.req(packPath, { method: "POST", headers: keyHeaders(k) })))!;
    const accepted = o.accepts[0]!;
    const channelId = String((accepted.extra as { channelId: string }).channelId);
    const lock = `lock-${randomBytes(6).toString("hex")}`;
    chain.putLock(txHash(lock), String((accepted.extra as { datum: string }).datum));
    const token = String((await srv.req(packPath, { method: "POST", headers: { ...keyHeaders(k), "payment-signature": paymentHeader(o, accepted, lock) } })).json.token);
    const auth = { authorization: `Bearer ${token}` };
    let closedAt = 0;
    const calls = Array.from({ length: 40 }, (_, i) => (async () => {
      await new Promise((r) => setTimeout(r, i * 3));
      const started = Date.now();
      const r = await srv.req(callPath, { headers: auth });
      return { started, status: r.status };
    })());
    const close = (async () => {
      await new Promise((r) => setTimeout(r, 50));
      const r = await srv.req(`/a/${h.seeded.apiId}/channels/${channelId}/close`, { method: "POST", headers: auth });
      closedAt = Date.now();
      return r.status;
    })();
    const [cs, out] = await Promise.all([close, Promise.all(calls)]);
    expect(cs).toBe(202);
    const servedAfterClose = out.filter((c) => c.started > closedAt && c.status === 200);
    expect(servedAfterClose).toEqual([]);
    const later = await srv.req(callPath, { headers: auth });
    expect(later.status).toBe(409);
    const ch = (await getChannel(h.sql, channelId))!;
    expect(ch.passes_served).toBe(out.filter((c) => c.status === 200).length);
  });
});
