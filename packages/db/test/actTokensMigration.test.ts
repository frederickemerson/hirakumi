import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, type Sql } from "../src/client";
import { migrate, MIGRATIONS_DIR } from "../src/migrate";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://hirakumi:hirakumi@localhost:5432/hirakumi";
const ACT_TOKENS = "0022_act_tokens.sql";
const PENDING_INTAKE = "0023_pending_intake.sql";

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

async function seedApi(sql: Sql): Promise<void> {
  await sql`insert into sellers (id, cardano_addr) values ('sel_a', 'addr_test1a')`;
  await sql`insert into apis (id, seller_id, name, origin, openapi_url) values ('api_a', 'sel_a', 'A', 'https://a.com', 'https://a.com/openapi.json')`;
}

describe(`migration ${ACT_TOKENS}`, () => {
  it("stores one-time links by hash, one action each, and refuses an unknown action or a reused hash", async () => {
    const sql = await migratedSchema();
    await seedApi(sql);
    await sql`insert into act_tokens (id, token_hash, api_id, action, wallet, expires_at) values ('act_1', 'h1', 'api_a', 'publish', 'addr_test1a', now() + interval '30 minutes')`;
    await expect(sql`insert into act_tokens (id, token_hash, api_id, action, wallet, expires_at) values ('act_2', 'h2', 'api_a', 'retire', 'addr_test1a', now())`).rejects.toThrow(/check/);
    await expect(sql`insert into act_tokens (id, token_hash, api_id, action, wallet, expires_at) values ('act_3', 'h1', 'api_a', 'key', 'addr_test1a', now())`).rejects.toThrow(/unique/);
    expect(await sql`select action, used_at from act_tokens`).toEqual([{ action: "publish", used_at: null }]);
    // Removing the API removes its links.
    await sql`delete from apis where id = 'api_a'`;
    expect(await sql`select 1 from act_tokens`).toEqual([]);
  }, 30_000);

  it("both migrations can run again and keep what is stored", async () => {
    const sql = await migratedSchema();
    await seedApi(sql);
    await sql`insert into act_tokens (id, token_hash, api_id, action, wallet, expires_at) values ('act_1', 'h1', 'api_a', 'key', 'addr_test1a', now())`;
    await sql`insert into coworker_tasks (task_id, sokosumi_user_id, task_name, setup_token, pending_intake) values ('tsk_1', 'u', 'n', 't', 'https://a.com/openapi.json')`;
    await sql.unsafe(await readFile(join(MIGRATIONS_DIR, ACT_TOKENS), "utf8"));
    await sql.unsafe(await readFile(join(MIGRATIONS_DIR, PENDING_INTAKE), "utf8"));
    expect(await sql`select id from act_tokens`).toEqual([{ id: "act_1" }]);
    expect(await sql`select pending_intake from coworker_tasks`).toEqual([{ pending_intake: "https://a.com/openapi.json" }]);
  }, 30_000);
});
