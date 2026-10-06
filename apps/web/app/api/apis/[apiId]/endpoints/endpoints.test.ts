import { beforeEach, describe, expect, it } from "vitest";
import { getSql } from "@/lib/db";
import { resetDb } from "@/test/db";
import { seedApi, seedOperation, seedSeller } from "@/test/factories";
import { cookieFor, ctx, jsonRequest } from "@/test/requests";
import { POST } from "./route";

async function setup(state: Parameters<typeof seedApi>[1] = "described") {
  const seller = await seedSeller();
  const api = await seedApi(seller.id, state);
  const get = await seedOperation(api.id, { opId: "getPrice", method: "GET", path: "/price" });
  const post = await seedOperation(api.id, { opId: "refreshCache", method: "POST", path: "/admin/refresh", sideEffectsLikely: true });
  return { seller, api, get, post };
}

function send(cookie: string, apiId: string, body: unknown) {
  return POST(jsonRequest(`/api/apis/${apiId}/endpoints`, { cookie, body }), ctx(apiId));
}

describe("POST /api/apis/:apiId/endpoints", () => {
  beforeEach(resetDb);

  it("saves the choice and moves to endpoints_confirmed", async () => {
    const { seller, api, get, post } = await setup();
    const res = await send(cookieFor(seller), api.id, {
      enabledIds: [get.id], confirmedNoSideEffectIds: [], escrowOperationId: get.id,
    });
    expect(res.status).toBe(200);
    const ops = await getSql()<{ id: string; enabled: boolean }[]>`select id, enabled from operations where api_id = ${api.id}`;
    expect(Object.fromEntries(ops.map((o) => [o.id, o.enabled]))).toEqual({ [get.id]: true, [post.id]: false });
    const [row] = await getSql()<{ state: string; escrowOpId: string }[]>`select state, escrow_op_id from apis where id = ${api.id}`;
    expect(row).toEqual({ state: "endpoints_confirmed", escrowOpId: "getPrice" });
  });

  it("records the no-side-effects confirmation for a POST endpoint", async () => {
    const { seller, api, post } = await setup();
    const res = await send(cookieFor(seller), api.id, {
      enabledIds: [post.id], confirmedNoSideEffectIds: [post.id], escrowOperationId: post.id,
    });
    expect(res.status).toBe(200);
    const [row] = await getSql()<{ sideEffectsConfirmedNone: boolean }[]>`
      select side_effects_confirmed_none from operations where id = ${post.id}`;
    expect(row.sideEffectsConfirmedNone).toBe(true);
  });

  it("refuses a POST endpoint without the confirmation", async () => {
    const { seller, api, post } = await setup();
    const res = await send(cookieFor(seller), api.id, { enabledIds: [post.id], confirmedNoSideEffectIds: [], escrowOperationId: post.id });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Confirm that POST /admin/refresh changes nothing on your server, or don't sell it." });
  });

  it("can be changed again before ownership is proved", async () => {
    const { seller, api, get } = await setup("endpoints_confirmed");
    const res = await send(cookieFor(seller), api.id, { enabledIds: [get.id], confirmedNoSideEffectIds: [], escrowOperationId: get.id });
    expect(res.status).toBe(200);
  });

  it("refuses once ownership is verified", async () => {
    const { seller, api, get } = await setup("ownership_verified");
    const res = await send(cookieFor(seller), api.id, { enabledIds: [get.id], confirmedNoSideEffectIds: [], escrowOperationId: get.id });
    expect(res.status).toBe(409);
  });

  it("returns 404 for another seller's API", async () => {
    const { api, get } = await setup();
    const intruder = await seedSeller();
    const res = await send(cookieFor(intruder), api.id, { enabledIds: [get.id], confirmedNoSideEffectIds: [], escrowOperationId: get.id });
    expect(res.status).toBe(404);
    const [row] = await getSql()<{ state: string }[]>`select state from apis where id = ${api.id}`;
    expect(row.state).toBe("described");
  });
});
