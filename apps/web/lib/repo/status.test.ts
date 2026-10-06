import { beforeEach, describe, expect, it } from "vitest";
import { getSql } from "@/lib/db";
import { resetDb } from "@/test/db";
import { seedApi, seedCall, seedSeller } from "@/test/factories";
import { getPublicStatus } from "./status";

beforeEach(async () => { await resetDb(); });

const NOW = new Date("2026-10-07T12:30:00Z");
const hoursAgo = (h: number, m = 0) => new Date(NOW.getTime() - h * 3_600_000 - m * 60_000);

describe("getPublicStatus (public status page)", () => {
  it("computes 24h uptime from monitor probes and an hourly strip, oldest first", async () => {
    const api = await seedApi((await seedSeller()).id, "live");
    for (let i = 0; i < 8; i++) await seedCall(api.id, { kind: "probe", verdict: "pass", createdAt: hoursAgo(0, i * 3) }); // 12:09–12:30, all in the current hour
    await seedCall(api.id, { kind: "probe", verdict: "fail", createdAt: hoursAgo(3, 10) });
    await seedCall(api.id, { kind: "probe", verdict: "fail", createdAt: hoursAgo(3, 20) });
    await seedCall(api.id, { kind: "probe", verdict: "pass", createdAt: hoursAgo(30) }); // outside the window
    const s = await getPublicStatus(getSql(), api.id, NOW);
    expect(s.uptimePct).toBe(80); // 8 of 10 probes in the last 24h
    expect(s.hours).toHaveLength(24);
    expect(s.hours[23]).toMatchObject({ probes: 8, passed: 8, state: "up" });
    expect(s.hours[20]).toMatchObject({ probes: 2, passed: 0, state: "down" });
    expect(s.hours[0]).toMatchObject({ probes: 0, state: "no_data" });
  });

  it("reports the paid-call pass rate separately from probes, and nothing when there's no data", async () => {
    const api = await seedApi((await seedSeller()).id, "live");
    const empty = await getPublicStatus(getSql(), api.id, NOW);
    expect(empty).toMatchObject({ uptimePct: null, paidCalls: 0, passRatePct: null });
    await seedCall(api.id, { kind: "credit", verdict: "pass", createdAt: hoursAgo(1) });
    await seedCall(api.id, { kind: "credit", verdict: "pass", createdAt: hoursAgo(2) });
    await seedCall(api.id, { kind: "escrow", verdict: "fail", createdAt: hoursAgo(2) });
    await seedCall(api.id, { kind: "preview", verdict: "fail", createdAt: hoursAgo(2) }); // onboarding test calls don't count
    const s = await getPublicStatus(getSql(), api.id, NOW);
    expect(s).toMatchObject({ paidCalls: 3, passRatePct: 67 });
  });
});
