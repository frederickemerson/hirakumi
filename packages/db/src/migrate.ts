import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "./client";

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");
const LOCK_KEY = 727274; // any constant; serialises concurrent migrators (gateway + coworker boot together)

/** Applies every *.sql in `dir` not yet in schema_migrations, in file-name order, in one transaction. */
export async function migrate(sql: Sql, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  await sql.begin(async (tx) => {
    await tx.unsafe(`select pg_advisory_xact_lock(${LOCK_KEY})`);
    await tx.unsafe(
      "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    const done = new Set(
      (await tx.unsafe<{ name: string }[]>("select name from schema_migrations")).map((r) => r.name),
    );
    for (const file of files) {
      if (done.has(file)) continue;
      await tx.unsafe(await readFile(join(dir, file), "utf8"));
      await tx.unsafe("insert into schema_migrations (name) values ($1)", [file]);
      applied.push(file);
    }
  });
  return applied;
}
