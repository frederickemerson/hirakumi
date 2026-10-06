import { beforeEach, describe, expect, it } from "vitest";
import { accountTotals } from "@/lib/account";
import { getSql } from "@/lib/db";
import { resetDb } from "@/test/db";
import { seedApi, seedCall, seedCreditToken, seedJob, seedOnboardStep, seedPack, seedSeller } from "@/test/factories";
import { getAccount } from "./account";
import { getOverviewStats } from "./stats";

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

describe("getAccount", () => {
  beforeEach(resetDb);

  it("returns null for a seller that doesn't exist", async () => {
    expect(await getAccount(getSql(), "sel_missing")).toBeNull();
  });

  it("returns the wallet, the created date and the linked Sokosumi user, with no APIs yet", async () => {
    const seller = await seedSeller();
    await getSql()`update sellers set sokosumi_user_id = 'usr_42' where id = ${seller.id}`;
    const account = await getAccount(getSql(), seller.id);
    expect(account).toMatchObject({ address: seller.cardanoAddr, sokosumiUserId: "usr_42", apis: [] });
    expect(new Date(account!.createdAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(accountTotals(account!.apis)).toEqual({ live: 0, paidCallsDay: 0, receivedMicros: "0" });
  });

  it("lists all of this seller's APIs, newest first, and no one else's", async () => {
    const seller = await seedSeller();
    const other = await seedSeller();
    const first = await seedApi(seller.id, "intake", { name: "First" });
    await getSql()`update apis set created_at = now() - interval '1 day' where id = ${first.id}`;
    await seedApi(seller.id, "retired", { name: "Second" });
    await seedApi(other.id, "live", { name: "Not mine" });
    const account = await getAccount(getSql(), seller.id);
    expect(account!.apis.map((a) => a.name)).toEqual(["Second", "First"]);
  });

  it("gives each API the same numbers as its overview page", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "live", { agentIdentifier: "agent_1", healthCheckedAt: new Date() });
    const pack = await seedPack(api.id, { priceMicros: "2000000", escrowPriceMicros: "3000000" });
    await seedCreditToken(api.id, pack.id, { status: "active" });
    await seedCreditToken(api.id, pack.id, { status: "pending", txHash: null });
    await seedJob(api.id, { status: "completed" });
    await seedJob(api.id, { status: "failed" });
    for (let i = 0; i < 3; i++) await seedCall(api.id, { verdict: "pass" });
    await seedCall(api.id, { verdict: "fail" });
    await seedCall(api.id, { verdict: "pass", createdAt: hoursAgo(30) });
    await seedCall(api.id, { kind: "probe" });
    const quiet = await seedApi(seller.id, "live");

    const account = await getAccount(getSql(), seller.id);
    const row = account!.apis.find((a) => a.id === api.id)!;
    const overview = await getOverviewStats(getSql(), api.id);
    expect(row).toMatchObject({ paidCallsDay: overview.callsDay, passDay: overview.passDay, failDay: overview.failDay });
    const received = BigInt(overview.packEarningsMicros) + BigInt(overview.escrowNetMicros);
    expect(row.receivedMicros).toBe(received.toString()); // 2 from the pack + 3 less 5% from the job
    expect(row.receivedMicros).toBe("4850000");
    expect(row.healthCheckedAt).not.toBeNull();
    expect(account!.apis.find((a) => a.id === quiet.id)).toMatchObject({ paidCallsDay: 0, receivedMicros: "0" });
    expect(accountTotals(account!.apis)).toEqual({ live: 2, paidCallsDay: 4, receivedMicros: "4850000" });
  });

  it("badges each API by where it stands", async () => {
    const seller = await seedSeller();
    const choosing = await seedApi(seller.id, "described");
    await seedOnboardStep(choosing.id, "parse", "done");
    await seedOnboardStep(choosing.id, "describe", "done");
    const stuck = await seedApi(seller.id, "parsed");
    await seedOnboardStep(stuck.id, "describe", "failed", { error: "boom" });
    const live = await seedApi(seller.id, "live");
    const down = await seedApi(seller.id, "live", { health: "down" });
    const retired = await seedApi(seller.id, "retired");
    const byId = new Map((await getAccount(getSql(), seller.id))!.apis.map((a) => [a.id, a.badge]));
    expect(byId.get(choosing.id)).toEqual({ tone: "progress", label: "In progress", detail: "Step 3 of 7: Choose endpoints. Your turn." });
    expect(byId.get(stuck.id)).toEqual({ tone: "failed", label: "Stopped", detail: "Step 2 of 7: Describe endpoints. It failed." });
    expect(byId.get(live.id)).toMatchObject({ tone: "live", label: "Live" });
    expect(byId.get(down.id)).toMatchObject({ tone: "down", label: "Down" });
    expect(byId.get(retired.id)).toMatchObject({ tone: "retired", label: "Retired" });
  });

  it("says which APIs can be deleted, by the same rule as the delete route", async () => {
    const seller = await seedSeller();
    const fresh = await seedApi(seller.id, "priced");
    const started = await seedApi(seller.id, "priced");
    await seedOnboardStep(started.id, "register", "running");
    const sold = await seedApi(seller.id, "priced");
    const pack = await seedPack(sold.id);
    await seedCreditToken(sold.id, pack.id);
    const live = await seedApi(seller.id, "live");
    const byId = new Map((await getAccount(getSql(), seller.id))!.apis.map((a) => [a.id, a.deleteBlocker]));
    expect(byId.get(fresh.id)).toBeNull();
    expect(byId.get(started.id)).toBe("This API reached the Masumi registry, so its records stay.");
    expect(byId.get(sold.id)).toBe("Buyers paid for this API, so its records stay.");
    expect(byId.get(live.id)).toBe("This API is on the Masumi registry. Retire it instead.");
  });
});
