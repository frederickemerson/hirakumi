import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { driveOnce, type StateHandlers } from "../src/onboarding/driver.js";
import { createTestDb, seedApi, type TestDb } from "./helpers/db.js";

let db: TestDb;
beforeAll(async () => (db = await createTestDb()));
afterAll(async () => db.close());

describe("driveOnce", () => {
  it("dispatches by state, never runs one API twice at once, and survives handler errors", async () => {
    const a = await seedApi(db.pool, { state: "intake" });
    const b = await seedApi(db.pool, { state: "registering" });
    await seedApi(db.pool, { state: "described" });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const handlers: StateHandlers = {
      intake: vi.fn(() => gate),
      parsed: vi.fn(),
      ownership_verified: vi.fn(),
      registering: vi.fn().mockRejectedValue(new Error("registry down")),
    };
    const log = { error: vi.fn(), info: vi.fn() };
    const inFlight = new Set<string>();
    const first = driveOnce(db.pool, handlers, inFlight, log);
    await vi.waitFor(() => expect(inFlight.has(a)).toBe(true));
    await driveOnce(db.pool, handlers, inFlight, log);
    release();
    await first;
    expect(handlers.intake).toHaveBeenCalledTimes(1);
    expect(handlers.intake).toHaveBeenCalledWith(a);
    expect(handlers.registering).toHaveBeenCalledWith(b);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("registry down"));
    expect(handlers.parsed).not.toHaveBeenCalled();
  });

  it("skips APIs whose onboarding failed for good, so they can't fill the 50-row window", async () => {
    const seen: string[] = [];
    const record = async (id: string) => { seen.push(id); };
    const handlers = { intake: record, parsed: record, ownership_verified: record, registering: record };
    const failed: string[] = [];
    for (let i = 0; i < 50; i++) {
      const id = await seedApi(db.pool, { state: "intake" });
      await db.pool.query(`insert into onboard_steps (api_id, step, status, output) values ($1, 'parse', 'failed', '{"error":"x"}')`, [id]);
      failed.push(id);
    }
    const fresh = await seedApi(db.pool, { state: "intake" });
    await driveOnce(db.pool, handlers, new Set(), { error: () => {}, info: () => {} });
    expect(seen).toContain(fresh);
    expect(seen.filter((id) => failed.includes(id))).toEqual([]);
  });
});
