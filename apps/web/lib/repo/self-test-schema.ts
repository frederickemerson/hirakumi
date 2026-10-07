import type postgres from "postgres";
import type { Sql } from "../db";

/**
 * Deploy order (like lib/repo/schema.ts for 0014/0015): the web may start before migration 0016 (seller self tests)
 * has run. Until it has, nothing is a self test yet, so stats count every pack as before, and the seller's
 * Try it live says it is being updated. Checked again every RECHECK_MS until present; migrations only add.
 */
const RECHECK_MS = 60_000;

type Check = { ready: boolean; at: number; pending: Promise<boolean> | null };
const g = globalThis as unknown as { __hirakumiSelfTestSchema?: Check };

/** True once migration 0016 ran: the self_test_credit_tokens view exists. */
export async function hasSelfTestSchema(sql: Sql | postgres.TransactionSql): Promise<boolean> {
  const c = (g.__hirakumiSelfTestSchema ??= { ready: false, at: 0, pending: null });
  if (c.ready || (c.at && Date.now() - c.at < RECHECK_MS)) return c.ready;
  c.pending ??= (async () => {
    try {
      const [row] = await sql<{ ready: boolean }[]>`
        select exists (
          select 1 from information_schema.views
          where table_schema = current_schema() and table_name = 'self_test_credit_tokens') as ready`;
      c.ready = row?.ready === true;
      c.at = Date.now();
      return c.ready;
    } finally {
      c.pending = null;
    }
  })();
  return c.pending;
}

/** Tests only. */
export function resetSelfTestSchemaCheck(): void {
  g.__hirakumiSelfTestSchema = undefined;
}
