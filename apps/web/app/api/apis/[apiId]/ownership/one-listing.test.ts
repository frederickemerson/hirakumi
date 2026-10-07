import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSql } from "@/lib/db";
import { setGatewayForTests, type ChallengeCheck, type Gateway } from "@/lib/gateway";
import { listingBaseNotes } from "@/lib/repo/apis";
import type { Api, Seller } from "@/lib/types";
import { resetDb } from "@/test/db";
import { seedApi, seedSeller } from "@/test/factories";
import { cookieFor, ctx, jsonRequest } from "@/test/requests";
import { makeTestWallet, type TestWallet } from "@/test/wallet-fixture";
import { POST as retire } from "../retire/route";
import { POST as dnsCheck } from "./dns-check/route";
import { POST as verify } from "./verify/route";
import { POST as walletChallenge } from "./wallet-challenge/route";

const TAKEN = "This API is already registered on Hirakumi by another account, so it can't be listed again. If it's yours, retire that listing first.";
const PASS: ChallengeCheck = { ok: true, reason: "verified", record: "_hirakumi.price.example.dev", detail: "ok" };

type Owner = { wallet: TestWallet; seller: Seller; cookie: string };

async function owner(): Promise<Owner> {
  const wallet = await makeTestWallet();
  const seller = await seedSeller(wallet.bech32);
  return { wallet, seller, cookie: cookieFor(seller) };
}

/** An API waiting for its ownership proof, with a fresh OpenAPI pass and a wallet message ready to sign. */
async function readyToSign(o: Owner, api: Api) {
  await dnsCheck(jsonRequest(`/api/apis/${api.id}/ownership/dns-check`, { cookie: o.cookie, body: {} }), ctx(api.id));
  const res = await walletChallenge(jsonRequest(`/api/apis/${api.id}/ownership/wallet-challenge`, { cookie: o.cookie, body: {} }), ctx(api.id));
  expect(res.status).toBe(200);
  const { challengeId, message } = (await res.json()) as { challengeId: string; message: string };
  return () => verify(jsonRequest(`/api/apis/${api.id}/ownership/verify`, {
    cookie: o.cookie, body: { challengeId, address: o.wallet.addressHex, ...o.wallet.sign(message) },
  }), ctx(api.id));
}

async function prove(o: Owner, api: Api) {
  const res = await (await readyToSign(o, api))();
  return { status: res.status, body: (await res.json()) as { state?: string; warnings?: string[]; error?: string } };
}

async function stateOf(apiId: string) {
  const [row] = await getSql()<{ state: string }[]>`select state from apis where id = ${apiId}`;
  return row.state;
}

let me: Owner;
let other: Owner;

describe("one API, one listing, one account (at proof of ownership)", () => {
  beforeEach(async () => {
    await resetDb();
    setGatewayForTests({ checkChallenge: vi.fn(async () => PASS), reloadApi: vi.fn(async () => undefined), getHealth: vi.fn(), getSettlement: vi.fn(async () => []) } as Gateway);
    me = await owner();
    other = await owner();
  });
  afterEach(() => setGatewayForTests(null));

  it("blocks an exact duplicate of another account's base, and reveals nothing about that account", async () => {
    const theirs = await seedApi(other.seller.id, "live", { name: "Secret Prices", pathPrefix: "/" });
    const mine = await seedApi(me.seller.id, "endpoints_confirmed", { origin: "https://PRICE.example.dev:443", pathPrefix: "" });
    // The ownership page says so before the seller does any work.
    expect(await listingBaseNotes(getSql(), mine.id)).toEqual({ blocked: TAKEN, warnings: [] });
    const r = await prove(me, mine);
    expect(r).toEqual({ status: 409, body: { error: TAKEN } });
    expect(JSON.stringify(r.body)).not.toMatch(/Secret Prices|sel_|addr_|api_/);
    expect(await stateOf(mine.id)).toBe("endpoints_confirmed");
    expect(await stateOf(theirs.id)).toBe("live");
    // The proof is not used up: once the other listing is gone, the seller can sign again.
    const open = await getSql()`select 1 from challenges where api_id = ${mine.id} and kind = 'dns' and consumed_at is null`;
    expect(open.length).toBe(1);
  });

  it("blocks an exact duplicate by the same account (a different spec link to the same base)", async () => {
    await seedApi(me.seller.id, "live", { name: "Price API v1", pathPrefix: "/v1", openapiUrl: "https://price.example.dev/openapi.json" });
    const mine = await seedApi(me.seller.id, "endpoints_confirmed", { pathPrefix: "/v1/", openapiUrl: "https://price.example.dev/v1/openapi.yaml" });
    const r = await prove(me, mine);
    expect(r).toEqual({ status: 409, body: { error: "You already list this API as Price API v1. Retire that listing first." } });
    expect(await stateOf(mine.id)).toBe("endpoints_confirmed");
  });

  it("blocks a base that overlaps another account's, in either direction", async () => {
    await seedApi(other.seller.id, "rule_built", { pathPrefix: "/v1/prices" });
    const wider = await seedApi(me.seller.id, "endpoints_confirmed", { pathPrefix: "/v1" });
    expect(await prove(me, wider)).toEqual({ status: 409, body: { error: TAKEN } });
    await resetDb();
    me = await owner();
    other = await owner();
    await seedApi(other.seller.id, "live", { pathPrefix: "/" });
    const narrower = await seedApi(me.seller.id, "endpoints_confirmed", { pathPrefix: "/v1" });
    expect(await prove(me, narrower)).toEqual({ status: 409, body: { error: TAKEN } });
  });

  it("allows an overlap with the seller's own listing, with a warning, also shown later on the review step", async () => {
    const own = await seedApi(me.seller.id, "live", { name: "Price API", pathPrefix: "/v1" });
    const mine = await seedApi(me.seller.id, "endpoints_confirmed", { name: "Prices only", pathPrefix: "/v1/prices" });
    const warning = "This overlaps your listing Price API, so some calls may be sold in both.";
    expect(await prove(me, mine)).toEqual({ status: 200, body: { state: "ownership_verified", warnings: [warning] } });
    // Nothing extra is stored: the warning is computed on read, from both sides.
    expect(await listingBaseNotes(getSql(), mine.id)).toEqual({ blocked: null, warnings: [warning] });
    expect((await listingBaseNotes(getSql(), own.id)).warnings).toEqual(["This overlaps your listing Prices only, so some calls may be sold in both."]);
  });

  it("/v1 and /v10 do not overlap", async () => {
    await seedApi(other.seller.id, "live", { pathPrefix: "/v1" });
    const mine = await seedApi(me.seller.id, "endpoints_confirmed", { pathPrefix: "/v10" });
    expect(await prove(me, mine)).toEqual({ status: 200, body: { state: "ownership_verified", warnings: [] } });
  });

  it("two accounts proving the same base at the same time: exactly one wins", async () => {
    const a = await seedApi(me.seller.id, "endpoints_confirmed", { pathPrefix: "/" });
    const b = await seedApi(other.seller.id, "endpoints_confirmed", { pathPrefix: "/" });
    const [signA, signB] = [await readyToSign(me, a), await readyToSign(other, b)];
    const results = await Promise.all([signA(), signB()]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const states = [await stateOf(a.id), await stateOf(b.id)].sort();
    expect(states).toEqual(["endpoints_confirmed", "ownership_verified"]);
  });

  it("two accounts proving overlapping bases at the same time: exactly one wins (the origin lock, not the index)", async () => {
    for (let round = 0; round < 3; round++) {
      await resetDb();
      me = await owner();
      other = await owner();
      const a = await seedApi(me.seller.id, "endpoints_confirmed", { pathPrefix: "/v1" });
      const b = await seedApi(other.seller.id, "endpoints_confirmed", { pathPrefix: "/v1/prices" });
      const [signA, signB] = [await readyToSign(me, a), await readyToSign(other, b)];
      const results = await Promise.all([signA(), signB()]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    }
  });

  it("retiring a listing frees its base, so it can be listed again", async () => {
    const theirs = await seedApi(other.seller.id, "live", { pathPrefix: "/" });
    const mine = await seedApi(me.seller.id, "endpoints_confirmed", { pathPrefix: "/" });
    expect((await prove(me, mine)).status).toBe(409);
    const res = await retire(jsonRequest(`/api/apis/${theirs.id}/retire`, { cookie: other.cookie, body: {} }), ctx(theirs.id));
    expect(res.status).toBe(200);
    expect(await prove(me, mine)).toEqual({ status: 200, body: { state: "ownership_verified", warnings: [] } });
  });

  it("deleting an unfinished listing frees its base too", async () => {
    const theirs = await seedApi(other.seller.id, "ownership_verified", { pathPrefix: "/" });
    const mine = await seedApi(me.seller.id, "endpoints_confirmed", { pathPrefix: "/" });
    expect((await prove(me, mine)).status).toBe(409);
    await getSql()`delete from apis where id = ${theirs.id}`;
    expect((await prove(me, mine)).status).toBe(200);
  });

  it("tells the Sokosumi task when a coworker seller is refused", async () => {
    await seedApi(other.seller.id, "live", { pathPrefix: "/" });
    const mine = await seedApi(me.seller.id, "endpoints_confirmed", { pathPrefix: "/", sokosumiTaskId: "tsk_dup" });
    expect((await prove(me, mine)).status).toBe(409);
    const msgs = await getSql()<{ taskId: string; body: string; taskStatus: string }[]>`
      select task_id, body, task_status from messages where api_id = ${mine.id}`;
    expect(msgs).toEqual([{ taskId: "tsk_dup", body: `Step 4 of 7, Prove ownership: ${TAKEN}`, taskStatus: "INPUT_REQUIRED" }]);
  });

  it("a refused duplicate never moves on toward registration", async () => {
    await seedApi(other.seller.id, "live", { pathPrefix: "/" });
    const mine = await seedApi(me.seller.id, "endpoints_confirmed", { pathPrefix: "/" });
    expect((await prove(me, mine)).status).toBe(409);
    // The coworker only drives intake, parsed, ownership_verified and registering; this API is in none of them.
    expect(await stateOf(mine.id)).toBe("endpoints_confirmed");
    // And the database refuses to put it there directly.
    await expect(getSql()`update apis set state = 'registering' where id = ${mine.id}`).rejects.toThrow(/apis_active_base_uniq/);
  });
});
