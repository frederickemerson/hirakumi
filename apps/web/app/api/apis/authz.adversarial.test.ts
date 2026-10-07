import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSql } from "@/lib/db";
import { setGatewayForTests, type Gateway } from "@/lib/gateway";
import { resetDb } from "@/test/db";
import { seedApi, seedSeller } from "@/test/factories";
import { cookieFor, ctx, jsonRequest } from "@/test/requests";
import { POST as retire } from "./[apiId]/retire/route";
import { POST as publish } from "./[apiId]/publish/route";
import { POST as pricing } from "./[apiId]/pricing/route";
import { POST as dnsCheck } from "./[apiId]/ownership/dns-check/route";

const stateOf = async (id: string) => (await getSql()<{ state: string }[]>`select state from apis where id = ${id}`)[0].state;

describe("adversarial: seller isolation (IDOR)", () => {
  beforeEach(async () => {
    await resetDb();
    setGatewayForTests({ checkChallenge: vi.fn(), reloadApi: vi.fn(async () => undefined), getHealth: vi.fn(), getSettlement: vi.fn(async () => []) } as Gateway);
  });
  afterEach(() => setGatewayForTests(null));

  it("another seller cannot retire, publish, price or check or read the verification code of a victim's API", async () => {
    const victim = await seedSeller();
    const attacker = await seedSeller();
    const live = await seedApi(victim.id, "live");
    const priced = await seedApi(victim.id, "priced");
    const ec = await seedApi(victim.id, "endpoints_confirmed");
    const c = cookieFor(attacker);
    expect((await retire(jsonRequest(`/x`, { cookie: c, body: {} }), ctx(live.id))).status).toBe(404);
    expect((await publish(jsonRequest(`/x`, { cookie: c, body: {} }), ctx(priced.id))).status).toBe(404);
    expect((await pricing(jsonRequest(`/x`, { cookie: c, body: { packCalls: "10", packPrice: "1", escrowPrice: "1" } }), ctx(priced.id))).status).toBe(404);
    expect((await dnsCheck(jsonRequest(`/x`, { cookie: c, body: {} }), ctx(ec.id))).status).toBe(404);
    expect(await getSql()`select 1 from challenges where api_id = ${ec.id}`).toHaveLength(0);
    expect(await stateOf(live.id)).toBe("live");
    expect(await stateOf(priced.id)).toBe("priced");
  });
});

describe("adversarial: CSRF on body-less state changes", () => {
  beforeEach(async () => {
    await resetDb();
    setGatewayForTests({ checkChallenge: vi.fn(), reloadApi: vi.fn(async () => undefined), getHealth: vi.fn(), getSettlement: vi.fn(async () => []) } as Gateway);
  });
  afterEach(() => setGatewayForTests(null));

  it("a cross-site form POST (no JSON content type, foreign Origin) cannot retire a live API", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "live");
    const req = new Request(`https://web.hirakumi.test/api/apis/${api.id}/retire`, {
      method: "POST",
      headers: {
        cookie: cookieFor(seller), "content-type": "application/x-www-form-urlencoded",
        origin: "https://evil.example", "sec-fetch-site": "cross-site",
      },
      body: "",
    });
    const res = await retire(req, ctx(api.id));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await stateOf(api.id)).toBe("live");
  });
});
