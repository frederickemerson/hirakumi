import postgres from "postgres";
import { env } from "./env";

export type Sql = postgres.Sql;

const globalForSql = globalThis as unknown as { __hirakumiSql?: Sql };

export function getSql(): Sql {
  if (!globalForSql.__hirakumiSql) {
    globalForSql.__hirakumiSql = postgres(env.databaseUrl(), {
      max: 3,
      idle_timeout: 20,
      connect_timeout: 10,
      // Column names only. JSON values (rule schemas) must keep the seller's own keys such as last_updated.
      transform: { column: { from: postgres.toCamel } },
      onnotice: () => {},
    });
  }
  return globalForSql.__hirakumiSql;
}

export async function closeSql(): Promise<void> {
  const sql = globalForSql.__hirakumiSql;
  globalForSql.__hirakumiSql = undefined;
  if (sql) await sql.end({ timeout: 5 });
}
