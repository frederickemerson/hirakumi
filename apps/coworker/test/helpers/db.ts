import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createPool } from "../../src/db.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://hirakumi:hirakumi@localhost:5432/hirakumi_test";

const rand = () => Math.random().toString(36).slice(2, 10);

export type TestDb = { pool: pg.Pool; close(): Promise<void> };

/** A fresh schema per test file with every migration applied, dropped on close. */
export async function createTestDb(): Promise<TestDb> {
  const schema = `t_${rand()}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`create schema ${schema}`);
  await admin.end();
  const pool = createPool(TEST_DATABASE_URL, schema);
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) await pool.query(readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"));
  return {
    pool,
    async close() {
      await pool.end();
      const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await c.connect();
      await c.query(`drop schema ${schema} cascade`);
      await c.end();
    },
  };
}

export async function seedApi(
  pool: pg.Pool,
  o: { state?: string; name?: string; openapiUrl?: string; sokosumiTaskId?: string | null } = {},
): Promise<string> {
  const sellerId = `sel_${rand()}`;
  const apiId = `api_${rand()}`;
  await pool.query(`insert into sellers (id, cardano_addr) values ($1, $2)`, [sellerId, `addr_test1${rand()}`]);
  await pool.query(
    `insert into apis (id, seller_id, name, origin, openapi_url, state, sokosumi_task_id)
     values ($1, $2, $3, 'https://price.example.dev', $4, $5, $6)`,
    [apiId, sellerId, o.name ?? "Price API", o.openapiUrl ?? "https://price.example.dev/openapi.json", o.state ?? "intake", o.sokosumiTaskId ?? null],
  );
  return apiId;
}

export async function seedOperation(
  pool: pg.Pool,
  apiId: string,
  o: { opId?: string; method?: string; path?: string; inputSchema?: unknown; enabled?: boolean; description?: string } = {},
): Promise<string> {
  const id = `op_${rand()}`;
  await pool.query(
    `insert into operations (id, api_id, op_id, method, path, input_schema, enabled, description)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
    [
      id,
      apiId,
      o.opId ?? "getPrice",
      o.method ?? "GET",
      o.path ?? "/price",
      JSON.stringify(
        o.inputSchema ?? {
          type: "object",
          properties: { symbol: { type: "string", examples: ["ADA", "BTC"] } },
          required: ["symbol"],
          additionalProperties: false,
        },
      ),
      o.enabled ?? true,
      o.description ?? "Returns the current price for a ticker symbol.",
    ],
  );
  return id;
}

export async function messagesFor(pool: pg.Pool, apiId: string) {
  const { rows } = await pool.query<{ body: string; task_status: string | null; task_id: string | null; dedupe_key: string | null }>(
    `select body, task_status, task_id, dedupe_key from messages where api_id = $1 order by id`,
    [apiId],
  );
  return rows;
}
