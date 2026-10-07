import { getSql } from "@/lib/db";
import { errorJson, json, readJson, requireSeller } from "@/lib/http";
import { findCoworkerTask } from "@/lib/repo/apis";
import { linkSokosumi } from "@/lib/repo/sokosumi-link";
import { linkRateLimited } from "../rate-limit";

/**
 * Link the Sokosumi account behind a setup link to the signed-in wallet, moving it from another wallet if needed.
 * Authorization: the private setup token plus a signature-authenticated session for this wallet.
 */
export async function POST(req: Request): Promise<Response> {
  const session = await requireSeller(req);
  if (session instanceof Response) return session;
  const limited = await linkRateLimited(session.sellerId);
  if (limited) return limited;
  const body = await readJson(req);
  const token = typeof body?.setupToken === "string" ? body.setupToken : "";
  if (!token || token.includes("\u0000")) return errorJson(400, "This link is missing its code. Open the link from your Sokosumi task again.");
  const task = await findCoworkerTask(getSql(), token);
  if (!task) return errorJson(400, "This setup link isn't valid any more. Open the latest link from your Sokosumi task.");
  const result = await linkSokosumi(getSql(), { sokosumiUserId: task.sokosumiUserId, sellerId: session.sellerId, addr: session.addr });
  if (!result.ok) {
    return errorJson(409, "This wallet is already linked to another Sokosumi account. Unlink it in Account settings first.");
  }
  return json({ linked: true, already: result.already, moved: result.moved.length });
}
