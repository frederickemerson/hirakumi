import { randomBytes } from "node:crypto";
import { createDb, type Sql } from "./client";
import { migrate } from "./migrate";

export type TestDb = { sql: Sql; schema: string; drop(): Promise<void> };

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://hirakumi:hirakumi@localhost:5432/hirakumi";

/** A fresh schema with all migrations applied. Every test gets its own; drop() removes it. */
export async function createTestDb(): Promise<TestDb> {
  const schema = `t_${randomBytes(6).toString("hex")}`;
  const admin = createDb(TEST_URL, { max: 1 });
  await admin.unsafe(`create schema ${schema}`);
  await admin.end();
  const sql = createDb(TEST_URL, { searchPath: schema, max: 4 });
  await migrate(sql);
  return {
    sql,
    schema,
    async drop() {
      await sql.end();
      const a = createDb(TEST_URL, { max: 1 });
      await a.unsafe(`drop schema if exists ${schema} cascade`);
      await a.end();
    },
  };
}
