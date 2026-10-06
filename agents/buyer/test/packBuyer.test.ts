import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPackDemo, type PackDemoOptions } from "../src/packBuyer.js";
import { TokenStore } from "../src/tokenStore.js";
import { NoAffordablePackError } from "../src/gatewayClient.js";
import { fakeGateway, GW, API, TOKEN, MASUMI_UNIT } from "./fakeGateway.js";

const opts = (over: Partial<PackDemoOptions> = {}): PackDemoOptions => ({
  gatewayUrl: GW, apiId: API, opId: "getPrice", query: { symbol: "ADA" }, calls: 2, intervalMs: 0,
  maxPackMicros: 5_000_000n, pendingTimeoutMs: 60_000, pendingPollMs: 3_000, ...over,
});
function deps(gw: ReturnType<typeof fakeGateway>, tokens = new TokenStore(join(mkdtempSync(join(tmpdir(), "hk-")), "t.json"))) {
  const lines: string[] = [];
  let now = 0;
  return {
    lines,
    tokens,
    buyPack: vi.fn(async (_url: string) => ({ token: TOKEN, credits: 5, apiId: API, txHash: "ab".repeat(32) })),
    make() {
      return {
        fetch: gw.fetch,
        buyPack: this.buyPack,
        tokens,
        log: (l: string) => lines.push(l),
        sleep: vi.fn(async (ms: number) => { now += ms; }),
        now: () => now,
      };
    },
  };
}

describe("runPackDemo", () => {
  it("buys once on 402, stores the token, then calls with credits", async () => {
    const gw = fakeGateway({ modes: ["pass", "pass"] });
    const h = deps(gw);
    const s = await runPackDemo(h.make(), opts());
    expect(h.buyPack).toHaveBeenCalledOnce();
    expect(s).toMatchObject({ bought: true, passed: 2, lastRemaining: 3, creditAccountingOk: true });
    expect(h.tokens.get(API)?.token).toBe(TOKEN);
    expect(h.lines.join("\n")).toContain(`https://preprod.cardanoscan.io/transaction/${"ab".repeat(32)}`);
  });

  it("op calls never hit /packs and buyPack only receives the buyUrl", async () => {
    const gw = fakeGateway({ modes: ["pass"] });
    const h = deps(gw);
    await runPackDemo(h.make(), opts({ calls: 1 }));
    expect(gw.state.urls.every((u) => u.includes("/x/getPrice"))).toBe(true);
    expect(h.buyPack.mock.calls.map((c) => c[0])).toEqual([`${GW}/a/${API}/packs/pk_demo`]);
  });

  it("422 uses no credit (gateway sends X-Credits-Remaining on refusals)", async () => {
    const gw = fakeGateway({ modes: ["pass", "fail", "fail", "pass"], remainingHeaderOnRefusal: true });
    const h = deps(gw);
    const s = await runPackDemo(h.make(), opts({ calls: 4 }));
    expect(s).toMatchObject({ passed: 2, notMet: 2, lastRemaining: 3, creditAccountingOk: true });
    const out = h.lines.join("\n");
    expect(out).toContain("422 promise not met: /usd is required");
    expect(out).toContain("credits unchanged: 4");
  });

  it("422 without the header is confirmed on the next 200", async () => {
    const gw = fakeGateway({ modes: ["pass", "fail", "pass"] });
    const s = await runPackDemo(deps(gw).make(), opts({ calls: 3 }));
    expect(s).toMatchObject({ notMet: 1, lastRemaining: 3, creditAccountingOk: true });
  });

  it("detects a gateway that charges on 422", async () => {
    const gw = fakeGateway({ modes: ["pass", "fail", "pass"], chargeOnFail: true });
    const h = deps(gw);
    const s = await runPackDemo(h.make(), opts({ calls: 3 }));
    expect(s.creditAccountingOk).toBe(false);
    expect(h.lines.join("\n")).toContain("CREDIT MISMATCH");
  });

  it("503 Down before paying: no purchase", async () => {
    const gw = fakeGateway({ downBeforePay: true });
    const h = deps(gw);
    const s = await runPackDemo(h.make(), opts());
    expect(h.buyPack).not.toHaveBeenCalled();
    expect(s.down).toBe(1);
  });

  it("waits while the token is pending, then succeeds", async () => {
    const gw = fakeGateway({ modes: ["pending", "pending", "pass"] });
    const h = deps(gw);
    const d = h.make();
    const s = await runPackDemo(d, opts({ calls: 1 }));
    expect(s.passed).toBe(1);
    expect(d.sleep).toHaveBeenCalledWith(3_000);
  });

  it("gives up if the token stays pending past the timeout", async () => {
    const gw = fakeGateway({ modes: Array(50).fill("pending") });
    await expect(runPackDemo(deps(gw).make(), opts({ calls: 1, pendingTimeoutMs: 9_000 }))).rejects.toThrow(/still pending/);
  });

  it("refuses a pack priced in the escrow unit and never pays", async () => {
    const gw = fakeGateway({ asset: MASUMI_UNIT });
    const h = deps(gw);
    await expect(runPackDemo(h.make(), opts())).rejects.toThrow(NoAffordablePackError);
    expect(h.buyPack).not.toHaveBeenCalled();
  });

  it("reuses a stored token without an unpaid request or a purchase", async () => {
    const gw = fakeGateway({ modes: ["pass"] });
    const h = deps(gw);
    h.tokens.put(API, { token: TOKEN, packId: "pk_demo", credits: 5, txHash: null, boughtAt: "x" });
    const s = await runPackDemo(h.make(), opts({ calls: 1 }));
    expect(h.buyPack).not.toHaveBeenCalled();
    expect(s.passed).toBe(1);
    expect(gw.state.urls).toHaveLength(1);
  });
});
