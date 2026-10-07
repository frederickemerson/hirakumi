import { getSql } from "@/lib/db";
import { json, requireSeller } from "@/lib/http";
import { unlinkSokosumi } from "@/lib/repo/sokosumi-link";
import { linkRateLimited } from "../rate-limit";

/** Remove the signed-in wallet's Sokosumi link. Its listings stay with this wallet. Idempotent. */
export async function POST(req: Request): Promise<Response> {
  const session = await requireSeller(req);
  if (session instanceof Response) return session;
  const limited = await linkRateLimited(session.sellerId);
  if (limited) return limited;
  const unlinked = await unlinkSokosumi(getSql(), session.sellerId);
  return json({ linked: false, changed: unlinked });
}
