import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSql } from "@/lib/db";
import { setGatewayForTests, type Gateway } from "@/lib/gateway";
import type { Api, Seller } from "@/lib/types";
import { resetDb } from "@/test/db";
import { seedApi, seedOperation, seedPack, seedRule, seedSeller } from "@/test/factories";
import { cookieFor, ctx, jsonRequest } from "@/test/requests";
import { POST as pricing } from "./pricing/route";
import { POST as publish } from "./publish/route";

let seller: Seller;
let api: Api;
const reloadApi = vi.fn(async () => undefined);

async function setup(state: Api["state"]) {
  seller = await seedSeller();
  api = await seedApi(seller.id, state);
  const op = await seedOperation(api.id, { enabled: true });
  await seedRule(op.id);
}

function price(body: unknown, cookie = cookieFor(seller)) {
  return pricing(jsonRequest(`/api/apis/${api.id}/pricing`, { cookie, body }), ctx(api.id));
}
function pub(cookie = cookieFor(seller)) {
  return publish(jsonRequest(`/api/apis/${api.id}/publish`, { cookie, body: {} }), ctx(api.id));
}
async function state() {
  const [row] = await getSql()<{ state: string }[]>`select state from apis where id = ${api.id}`;
  return row.state;
}

describe("pricing and publish", () => {
  beforeEach(async () => {
    await resetDb();
    reloadApi.mockClear();
    setGatewayForTests({ checkChallenge: vi.fn(), reloadApi, getHealth: vi.fn(), getSettlement: vi.fn(async () => []) } as Gateway);
  });
  afterEach(() => setGatewayForTests(null));

  it("stores 2.5 tUSDM as 2500000 micros and moves to priced", async () => {
    await setup("rule_built");
    const res = await price({ packCalls: "100", packPrice: "2.5", escrowPrice: "2" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "priced", pack: { calls: 100, priceMicros: "2500000", escrowPriceMicros: "2000000" } });
    const packs = await getSql()<{ priceMicros: string }[]>`select price_micros::text as price_micros from packs where api_id = ${api.id}`;
    expect(packs).toEqual([{ priceMicros: "2500000" }]);
    expect(await state()).toBe("priced");
    expect(reloadApi).toHaveBeenCalledWith(api.id);
  });

  it("re-saving the price updates the same pack", async () => {
    await setup("rule_built");
    await price({ packCalls: "100", packPrice: "2", escrowPrice: "2" });
    await price({ packCalls: "50", packPrice: "1.5", escrowPrice: "3" });
    const packs = await getSql()<{ calls: number }[]>`select calls from packs where api_id = ${api.id}`;
    expect(packs).toEqual([{ calls: 50 }]);
  });

  it("refuses a pack under 1 tUSDM in plain English", async () => {
    await setup("rule_built");
    const res = await price({ packCalls: "100", packPrice: "0.5", escrowPrice: "2" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "A pack must cost at least 1 tUSDM. Cardano can't move smaller token payments cheaply." });
  });

  it("explains a malformed amount", async () => {
    await setup("rule_built");
    const res = await price({ packCalls: "100", packPrice: "two", escrowPrice: "2" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/^Enter an amount like 2 or 2.50/);
  });

  it("still saves the price when the gateway reload fails", async () => {
    await setup("rule_built");
    reloadApi.mockRejectedValueOnce(new Error("down"));
    expect((await price({ packCalls: "100", packPrice: "2", escrowPrice: "2" })).status).toBe(200);
  });

  it("refuses pricing before the test calls finished", async () => {
    await setup("ownership_verified");
    expect((await price({ packCalls: "100", packPrice: "2", escrowPrice: "2" })).status).toBe(409);
  });

  it("refuses pricing when an enabled endpoint has no promise yet", async () => {
    await setup("rule_built");
    await seedOperation(api.id, { opId: "getHistory", path: "/history", enabled: true });
    const res = await price({ packCalls: "100", packPrice: "2", escrowPrice: "2" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "The test calls haven't finished for every endpoint yet. Wait a moment and reload." });
  });

  it("returns 404 for another seller's API", async () => {
    await setup("rule_built");
    const intruder = await seedSeller();
    expect((await price({ packCalls: "100", packPrice: "2", escrowPrice: "2" }, cookieFor(intruder))).status).toBe(404);
  });

  it("publish before pricing is refused", async () => {
    await setup("rule_built");
    expect((await pub()).status).toBe(409);
    expect(await state()).toBe("rule_built");
  });

  it("publishes a priced API into registering", async () => {
    await setup("priced");
    await seedPack(api.id);
    const res = await pub();
    expect(res.status).toBe(200);
    expect(await state()).toBe("registering");
  });

  it("two concurrent publishes: exactly one succeeds", async () => {
    await setup("priced");
    await seedPack(api.id);
    const statuses = (await Promise.all([pub(), pub()])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
  });
});
