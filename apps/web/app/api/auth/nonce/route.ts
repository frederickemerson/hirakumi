import { AddressError, toPreprodBech32 } from "@/lib/cardano";
import { errorJson, json, readJson } from "@/lib/http";
import { issueLoginChallenge } from "@/lib/session";

export async function POST(req: Request): Promise<Response> {
  const body = await readJson(req);
  if (!body || typeof body.address !== "string") return errorJson(400, "Connect a wallet first.");
  let addr: string;
  try {
    addr = toPreprodBech32(body.address);
  } catch (e) {
    if (e instanceof AddressError) return errorJson(400, e.message);
    throw e;
  }
  const { message, nonceToken } = issueLoginChallenge(addr);
  return json({ address: addr, message, nonceToken });
}
