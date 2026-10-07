import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, type Sql } from "../src/client";
import { migrate, MIGRATIONS_DIR } from "../src/migrate";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://hirakumi:hirakumi@localhost:5432/hirakumi";
const NEEDS_KEY = "0021_operation_needs_key.sql";

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

async function seedOp(sql: Sql, id: string, needsKey?: boolean | null): Promise<void> {
  await sql`insert into sellers (id, cardano_addr) values (${`sel_${id}`}, ${`addr_test1${id}`}) on conflict do nothing`;
  await sql`
    insert into apis (id, seller_id, name, origin, openapi_url)
    values (${`api_${id}`}, ${`sel_${id}`}, 'A', ${`https://${id}.com`}, ${`https://${id}.com/openapi.json`})`;
  if (needsKey === undefined) {
    await sql`insert into operations (id, api_id, op_id, method, path, input_schema) values (${id}, ${`api_${id}`}, 'getPrice', 'GET', '/price', '{}')`;
  } else {
    await sql`
      insert into operations (id, api_id, op_id, method, path, input_schema, needs_key)
      values (${id}, ${`api_${id}`}, 'getPrice', 'GET', '/price', '{}', ${needsKey})`;
  }
}

describe(`migration ${NEEDS_KEY}`, () => {
  it("adds operations.needs_key: unknown (null) unless the parse step says true or false", async () => {
    const sql = await migratedSchema();
    await seedOp(sql, "a");
    await seedOp(sql, "b", true);
    await seedOp(sql, "c", false);
    expect(await sql`select id, needs_key from operations order by id`).toEqual([
      { id: "a", needs_key: null }, { id: "b", needs_key: true }, { id: "c", needs_key: false },
    ]);
  }, 30_000);

  it("can run again and keeps what is stored", async () => {
    const sql = await migratedSchema();
    await seedOp(sql, "b", true);
    await sql.unsafe(await readFile(join(MIGRATIONS_DIR, NEEDS_KEY), "utf8"));
    expect(await sql`select needs_key from operations`).toEqual([{ needs_key: true }]);
  }, 30_000);
});
