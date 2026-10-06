import { beforeEach, describe, expect, it } from "vitest";
import { getSql } from "@/lib/db";
import { resetDb } from "@/test/db";
import { seedApi, seedCall, seedCreditToken, seedHealthEvent, seedJob, seedPack, seedSeller } from "@/test/factories";
import { getOverviewStats, listIncidents } from "./stats";

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

describe("overview stats", () => {
  beforeEach(resetDb);

  it("counts paid calls in the last 24 hours and the pass rate", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "live");
    for (let i = 0; i < 3; i++) await seedCall(api.id, { verdict: "pass" });
    await seedCall(api.id, { verdict: "fail" });
    await seedCall(api.id, { verdict: "pass", createdAt: minutesAgo(60 * 48) });
    await seedCall(api.id, { kind: "probe", verdict: "pass" });
    const s = await getOverviewStats(getSql(), api.id);
    expect(s).toMatchObject({ callsDay: 4, passDay: 3, failDay: 1, passRate: 0.75 });
  });

  it("has no pass rate before any paid call", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "live");
    expect((await getOverviewStats(getSql(), api.id)).passRate).toBeNull();
  });

  it("sums settled pack sales and escrow earnings net of Masumi's 5%", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "live");
    const pack = await seedPack(api.id, { priceMicros: "2000000", escrowPriceMicros: "2000000" });
    await seedCreditToken(api.id, pack.id, { status: "active" });
    await seedCreditToken(api.id, pack.id, { status: "exhausted" });
    await seedCreditToken(api.id, pack.id, { status: "pending", txHash: null });
    for (let i = 0; i < 3; i++) await seedJob(api.id, { status: "completed" });
    await seedJob(api.id, { status: "failed" });
    const s = await getOverviewStats(getSql(), api.id);
    expect(s).toMatchObject({
      packSales: 2, packEarningsMicros: "4000000",
      escrowJobs: 3, escrowGrossMicros: "6000000", escrowFeeMicros: "300000", escrowNetMicros: "5700000",
    });
  });

  it("reports downtime with credits used and calls that didn't pass", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "live");
    await seedHealthEvent(api.id, "healthy", "down", minutesAgo(30), ["$.price is missing"]);
    await seedCall(api.id, { verdict: "fail", createdAt: minutesAgo(29) });
    await seedCall(api.id, { verdict: "n/a", execution: "blocked", createdAt: minutesAgo(28) });
    await seedHealthEvent(api.id, "down", "healthy", minutesAgo(20));
    await seedCall(api.id, { verdict: "pass", createdAt: minutesAgo(10) });
    await seedHealthEvent(api.id, "healthy", "down", minutesAgo(5));
    const incidents = await listIncidents(getSql(), api.id);
    expect(incidents).toHaveLength(2);
    expect(incidents[0]).toMatchObject({ upAt: null, creditsUsed: 0, callsNotPassed: 0 });
    expect(incidents[1]).toMatchObject({ creditsUsed: 0, callsNotPassed: 2, reasons: ["$.price is missing"] });
    expect(incidents[1].upAt).not.toBeNull();
  });
});
