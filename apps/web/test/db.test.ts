import { beforeEach, describe, expect, it } from "vitest";
import { getSql } from "@/lib/db";
import { resetDb } from "./db";
import { seedApi, seedOperation, seedRule, seedSeller } from "./factories";

describe("test database harness", () => {
  beforeEach(resetDb);

  it("has the contract schema applied", async () => {
    const rows = await getSql()<{ tableName: string }[]>`
      select table_name from information_schema.tables where table_schema = 'public' order by table_name`;
    const names = rows.map((r) => r.tableName);
    for (const t of ["apis", "calls", "challenges", "credit_tokens", "health_events", "jobs", "operations", "packs", "rules", "sellers"]) {
      expect(names).toContain(t);
    }
  });

  it("returns camelCase columns but keeps JSON keys exactly as stored", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "rule_built");
    const op = await seedOperation(api.id);
    await seedRule(op.id);
    const [row] = await getSql()<{ operationId: string; definition: { schema: { properties: object } } }[]>`
      select operation_id, definition from rules where operation_id = ${op.id}`;
    expect(row.operationId).toBe(op.id);
    expect(row.definition.schema.properties).toHaveProperty("last_updated");
    expect(row.definition.schema.properties).not.toHaveProperty("lastUpdated");
  });

  it("empties every table between tests", async () => {
    const [{ count }] = await getSql()<{ count: number }[]>`select count(*)::int as count from apis`;
    expect(count).toBe(0);
  });
});
