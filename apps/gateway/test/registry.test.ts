import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@hirakumi/db/testing";
import { HealthTracker } from "../src/health";
import { ApiRegistry, escrowOperation, primaryRule } from "../src/registry";
import { seedLiveApi, type Seeded } from "./helpers";

let db: TestDb; let s: Seeded; let health: HealthTracker; let registry: ApiRegistry;
beforeEach(async () => {
  db = await createTestDb();
  s = await seedLiveApi(db.sql, "https://price.example", { health: "down" });
  health = new HealthTracker({ failsToDown: 2, passesToHeal: 2 });
  registry = new ApiRegistry(db.sql, health);
});
afterEach(async () => { await db.drop(); });

describe("ApiRegistry", () => {
  it("loads ops by op_id with a compiled rule and seeds health from the DB", async () => {
    const l = await registry.get(s.apiId);
    const op = l?.ops.get("getPrice");
    expect(op?.rule?.hash).toBe(s.ruleHash);
    expect(op?.ruleRow?.id).toBe(s.ruleId);
    expect(l?.packs.map((p) => p.id)).toEqual([s.packId]);
    expect(health.get(s.apiId)?.health).toBe("down");
    expect(escrowOperation(l!)?.row.id).toBe(s.operationId);
    expect(primaryRule(l!)?.hash).toBe(s.ruleHash);
  });
  it("validates input with coercion and reports plain reasons", async () => {
    const op = (await registry.get(s.apiId))!.ops.get("getPrice")!;
    expect(op.validateInput({ symbol: "ADA" })).toEqual({ ok: true, value: { symbol: "ADA" } });
    expect(op.validateInput({})).toEqual({ ok: false, reasons: ["/symbol is missing"] });
    expect(op.validateInput({ symbol: "ADA", x: "1" })).toMatchObject({ ok: false });
  });
  it("drops a rule whose stored hash does not match its definition", async () => {
    await db.sql`update rules set hash = 'sha256:tampered' where id = ${s.ruleId}`;
    const op = (await registry.get(s.apiId, { fresh: true }))!.ops.get("getPrice")!;
    expect(op.rule).toBeNull();
  });
  it("caches until invalidate(), which also forgets in-memory health", async () => {
    await registry.get(s.apiId);
    await db.sql`update packs set price_micros = 3000000 where id = ${s.packId}`;
    expect((await registry.get(s.apiId))!.packs[0].price_micros).toBe("2000000");
    registry.invalidate(s.apiId);
    expect(health.get(s.apiId)).toBeUndefined();
    expect((await registry.get(s.apiId))!.packs[0].price_micros).toBe("3000000");
  });
  it("returns null for unknown APIs and does not cache the miss", async () => {
    expect(await registry.get("api_nope")).toBeNull();
  });
});
