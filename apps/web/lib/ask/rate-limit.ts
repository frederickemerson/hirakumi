import { createHash } from "node:crypto";
import { clientAddress } from "../client-address";
import type { Sql } from "../db";

export const ASK_LIMIT = 10;
const ASK_WINDOW_SECONDS = 5 * 60;

/** The rate-limit key: the seller for a signed-in caller, otherwise a hash of the client address (no raw IPs stored). */
export function askBucket(sellerId: string | null, req: Request): string {
  if (sellerId) return `seller:${sellerId}`;
  const ip = clientAddress(req);
  return `ip:${createHash("sha256").update(ip).digest("hex").slice(0, 32)}`;
}

/**
 * Records one question for `bucket` if it is under the limit. Counted in Postgres, under a per-bucket advisory lock,
 * so the limit holds across serverless instances and concurrent requests. Old rows are pruned on the way.
 * Returns false when the caller has used up the window.
 */
export async function takeAskSlot(sql: Sql, bucket: string, limit = ASK_LIMIT, windowSeconds = ASK_WINDOW_SECONDS): Promise<boolean> {
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`ask:${bucket}`}))`;
    await tx`delete from ask_requests where created_at < now() - make_interval(secs => ${windowSeconds})`;
    const [{ used }] = await tx<{ used: number }[]>`
      select count(*)::int as used from ask_requests where bucket = ${bucket}`;
    if (used >= limit) return false;
    await tx`insert into ask_requests (bucket) values (${bucket})`;
    return true;
  });
}
