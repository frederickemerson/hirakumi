import { afterEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../src/testing";
import { migrate } from "../src/migrate";

let db: TestDb | undefined;
afterEach(async () => { await db?.drop(); db = undefined; });

describe("migrate", () => {
  it("creates every contract table inside the throwaway schema", async () => {
    db = await createTestDb();
    const rows = await db.sql<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = ${db.schema} order by table_name`;
    expect(rows.map((r) => r.table_name)).toEqual([
      "act_tokens", "api_domains", "apis", "ask_requests", "calls", "challenges", "channel_leases", "coworker_task_events", "coworker_tasks", "credit_tokens", "health_events", "jobs", "messages",
      "onboard_steps", "operations", "pack_channels", "pack_quotes", "packs", "revoked_sessions", "rules", "schema_migrations", "self_test_credit_tokens", "self_test_packs",
      "sellers", "settlement_decisions", "test_inputs", "try_call_slots", "try_tokens", "used_login_nonces",
    ]);
  });

  it("is idempotent: a second run applies nothing", async () => {
    db = await createTestDb();
    expect(await migrate(db.sql)).toEqual([]);
  }, 30_000); // replays every migration; slow under a parallel workspace run

  it("rejects non-preprod seller addresses", async () => {
    db = await createTestDb();
    await expect(db.sql`insert into sellers (id, cardano_addr) values ('sel_x', 'addr1qxyz')`)
      .rejects.toThrow(/check constraint/);
  });
});
