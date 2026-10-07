import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, type Sql } from "../src/client";
import { migrate, MIGRATIONS_DIR } from "../src/migrate";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://hirakumi:hirakumi@localhost:5432/hirakumi";
const EXPOSURE = "0019_exposure.sql";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

async function migratedSchema(): Promise<Sql> {
  const schema = `t_${randomBytes(6).toString("hex")}`;
  const admin = createDb(TEST_URL, { max: 1 });
  await admin.unsafe(`create schema ${schema}`);
  await admin.end();
  const sql = createDb(TEST_URL, { searchPath: schema, max: 2 });
  cleanup = async () => {
    await sql.end();
    const a = createDb(TEST_URL, { max: 1 });
    await a.unsafe(`drop schema if exists ${schema} cascade`);
    await a.end();
  };
  await migrate(sql);
  return sql;
}

describe(`migration ${EXPOSURE}`, () => {
  it("starts every API at 'unknown', never checked, and accepts only the three results", async () => {
    const sql = await migratedSchema();
    await sql`insert into sellers (id, cardano_addr) values ('sel_a', 'addr_test1sel_a')`;
    await sql`
      insert into apis (id, seller_id, name, origin, openapi_url, state)
      values ('api_live', 'sel_a', 'Live', 'https://l.com', 'https://l.com/openapi.json', 'live')`;
    expect(await sql`select state, exposure, exposure_checked_at from apis`).toEqual([
      { state: "live", exposure: "unknown", exposure_checked_at: null },
    ]);
    for (const value of ["open", "protected", "unknown"]) await sql`update apis set exposure = ${value}`;
    await expect(sql`update apis set exposure = 'maybe'`).rejects.toThrow(/apis_exposure_check/);
  }, 30_000);

  it("can run again and keeps what is stored", async () => {
    const sql = await migratedSchema();
    await sql`insert into sellers (id, cardano_addr) values ('sel_a', 'addr_test1sel_a')`;
    await sql`
      insert into apis (id, seller_id, name, origin, openapi_url, exposure, exposure_checked_at)
      values ('api_a', 'sel_a', 'A', 'https://a.com', 'https://a.com/openapi.json', 'protected', now())`;
    await sql.unsafe(await readFile(join(MIGRATIONS_DIR, EXPOSURE), "utf8"));
    const [row] = await sql<{ exposure: string; checked: boolean }[]>`select exposure, exposure_checked_at is not null as checked from apis`;
    expect(row).toEqual({ exposure: "protected", checked: true });
  }, 30_000);
});
