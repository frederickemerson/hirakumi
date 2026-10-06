import { beforeEach, describe, expect, it } from "vitest";
import { getSql } from "@/lib/db";
import { resetDb } from "@/test/db";
import { seedApi, seedCreditToken, seedJob, seedPack, seedSeller } from "@/test/factories";
import { listEscrowJobs, listPackSales } from "./stats";

describe("sales", () => {
  beforeEach(resetDb);

  it("lists pack sales newest first with the pack price and transaction hash", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "live");
    const pack = await seedPack(api.id, { priceMicros: "2000000", calls: 100 });
    await seedCreditToken(api.id, pack.id, { txHash: "aaa", createdAt: new Date("2026-10-06T10:00:00Z") });
    await seedCreditToken(api.id, pack.id, { txHash: "bbb", remaining: 40, createdAt: new Date("2026-10-06T11:00:00Z") });
    const sales = await listPackSales(getSql(), api.id);
    expect(sales.map((s) => s.txHash)).toEqual(["bbb", "aaa"]);
    expect(sales[0]).toMatchObject({ calls: 100, priceMicros: "2000000", remaining: 40, status: "active" });
  });

  it("lists escrow jobs with failure reasons", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "live");
    await seedJob(api.id, { status: "failed", failureReasons: ["$.price is missing"] });
    const jobs = await listEscrowJobs(getSql(), api.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: "failed", failureReasons: ["$.price is missing"], identifierFromPurchaser: "buyer-ref-1" });
  });
});
