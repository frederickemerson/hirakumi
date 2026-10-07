import { AddressError, toPreprodBech32 } from "./cardano";
import { clientAddress } from "./client-address";
import { errorJson, json, readJson } from "./http";

/**
 * Does a wallet have anything on Cardano preprod? Preprod and preview both report network id 0
 * over CIP-30, so a wallet on preview (or a brand-new one) looks fine until its first payment fails.
 * Blockfrost preprod is the authority: an address it has never seen answers 404, a seen one lists
 * its amounts. Server-side only; the project id never reaches the browser.
 */
export type FundsStatus = "funded" | "empty" | "unknown";

const MAX_ADDRESSES = 5;
const TIMEOUT_MS = 4_000;

type Deps = {
  projectId: string | undefined;
  baseUrl: string;
  fetchImpl?: typeof fetch;
};

export const DEFAULT_BLOCKFROST_PREPROD = "https://cardano-preprod.blockfrost.io/api/v0";

async function lovelaceAt(d: Deps, bech32: string): Promise<bigint | null | "error"> {
  const doFetch = d.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${d.baseUrl.replace(/\/+$/, "")}/addresses/${encodeURIComponent(bech32)}`, {
      headers: { project_id: d.projectId ?? "" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return "error";
  }
  if (res.status === 404) return null; // never seen on preprod
  if (!res.ok) return "error";
  const data = (await res.json().catch(() => null)) as { amount?: { unit: string; quantity: string }[] } | null;
  const lovelace = data?.amount?.find((a) => a.unit === "lovelace")?.quantity;
  return lovelace && /^\d+$/.test(lovelace) ? BigInt(lovelace) : 0n;
}

export async function preprodFunds(d: Deps, addresses: string[]): Promise<FundsStatus> {
  if (!d.projectId || addresses.length === 0) return "unknown";
  const results = await Promise.all(addresses.map((a) => lovelaceAt(d, a)));
  if (results.some((r) => typeof r === "bigint" && r > 0n)) return "funded";
  // Only say "empty" when Blockfrost answered for every address; a failed lookup proves nothing.
  return results.some((r) => r === "error") ? "unknown" : "empty";
}

export function createPreprodFundsHandler(d: Deps & { allow: (key: string) => boolean }) {
  return async (req: Request): Promise<Response> => {
    const body = await readJson(req);
    const raw = body?.addresses;
    if (!Array.isArray(raw) || raw.length === 0 || raw.some((a) => typeof a !== "string")) {
      return errorJson(400, "Connect a wallet first.");
    }
    if (!d.allow(clientAddress(req))) return json({ status: "unknown" });
    let addresses: string[];
    try {
      addresses = [...new Set((raw as string[]).slice(0, MAX_ADDRESSES).map(toPreprodBech32))];
    } catch (e) {
      if (e instanceof AddressError) return errorJson(400, e.message);
      throw e;
    }
    return json({ status: await preprodFunds(d, addresses) });
  };
}
