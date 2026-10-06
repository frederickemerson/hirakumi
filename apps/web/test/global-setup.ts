import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { TEST_DATABASE_URL } from "./env";

export const MIGRATIONS_DIR = join(import.meta.dirname, "..", "..", "..", "db", "migrations");

/** Recreates the database from the migrations; `before` (a file name such as "0014") stops at that migration. */
export async function resetDatabase(url: string, before?: string): Promise<void> {
  const dbName = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!/test|e2e/.test(dbName)) {
    throw new Error(`Refusing to reset "${dbName}": the database name must contain "test" or "e2e".`);
  }
  const adminUrl = new URL(url);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    const found = await admin`select 1 from pg_database where datname = ${dbName}`;
    if (found.length === 0) await admin.unsafe(`create database "${dbName.replace(/"/g, '""')}"`);
  } finally {
    await admin.end();
  }
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe("drop schema if exists public cascade; create schema public;");
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql") && (!before || f < before)).sort();
    for (const file of files) await sql.unsafe(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  } finally {
    await sql.end();
  }
}

export default async function globalSetup(): Promise<void> {
  await resetDatabase(TEST_DATABASE_URL);
}
