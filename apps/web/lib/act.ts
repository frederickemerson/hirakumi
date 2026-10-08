import type { ActAction } from "@hirakumi/core";
import { AddressError, toPreprodBech32 } from "./cardano";
import { STATE_LABEL } from "./copy";
import type { Sql } from "./db";
import { formatTusdm } from "./money";
import { getApiForSeller } from "./repo/apis";
import { findActToken, type ActToken } from "./repo/act-tokens";
import { getPack } from "./repo/packs";
import { getAuthHint, type AuthHint } from "./repo/upstream-auth";
import type { Api, ApiState } from "./types";

/**
 * The one-time links of a Sokosumi task (/act/<token>): one focused page per wallet step. The token only selects the
 * API and the action; the API owner's wallet signature on the page is the authority, checked by the same code as the
 * website (verifyCip30Signature against the owner's address, finalizeOwnership, the sealed nonce of a login).
 */

/** Where each action can run. A link for a step the API has passed, or not reached, does nothing. */
const ACT_STATES: Record<ActAction, readonly ApiState[]> = {
  ownership: ["endpoints_confirmed"],
  key: ["endpoints_confirmed", "ownership_verified", "rule_built", "priced", "registering", "live"],
  publish: ["priced"],
};

export const ACT_DONE = "Done. You can close this tab; the rest continues in Sokosumi.";
const INVALID = "This link isn't valid. Reply in your Sokosumi task and Hirakumi sends a new one.";
const USED = "This link was already used. The rest continues in Sokosumi; reply there if you need a new link.";
const EXPIRED = "This link expired. Reply in your Sokosumi task and Hirakumi sends a new one.";

export type ActRouteContext = { params: Promise<{ token: string }> };
export type Owner = { sellerId: string; addr: string };
export type OpenedAct = { ok: true; act: ActToken; api: Api; owner: Owner };
export type ActRefusal = { ok: false; status: 403 | 404 | 409 | 410; error: string };

/** "…abc123": how the page and the comment name a wallet. */
export const walletTail = (addr: string) => `…${addr.slice(-6)}`;
export const hostOf = (api: Pick<Api, "origin">) => {
  try {
    return new URL(api.origin).hostname;
  } catch {
    return api.origin;
  }
};

/** The link, its API and the API's owner, when the link can still act. */
export async function openAct(sql: Sql, token: string): Promise<OpenedAct | ActRefusal> {
  const act = await findActToken(sql, token);
  if (!act) return { ok: false, status: 404, error: INVALID };
  if (act.used) return { ok: false, status: 410, error: USED };
  if (act.expired) return { ok: false, status: 410, error: EXPIRED };
  const [owner] = await sql<Owner[]>`
    select s.id as seller_id, s.cardano_addr as addr from apis a join sellers s on s.id = a.seller_id
    where a.id = ${act.apiId} and a.deleted_at is null`;
  const api = owner ? await getApiForSeller(sql, act.apiId, owner.sellerId) : null;
  if (!api || !owner) return { ok: false, status: 404, error: INVALID };
  if (!ACT_STATES[act.action].includes(api.state)) {
    return {
      ok: false, status: 409,
      error: `This link is for a step your API isn't at any more (it is at: ${STATE_LABEL[api.state]}). The rest continues in Sokosumi; reply there if you need a new link.`,
    };
  }
  return { ok: true, act, api, owner };
}

/** Null when the wallet that signs is the API owner's, else the refusal. Address in hex (CIP-30) or bech32. */
export function wrongWallet(opened: OpenedAct, address: unknown): ActRefusal | null {
  let signer: string | null = null;
  try {
    signer = typeof address === "string" ? toPreprodBech32(address) : null;
  } catch (e) {
    if (!(e instanceof AddressError)) throw e;
  }
  if (signer === opened.owner.addr) return null;
  return {
    ok: false, status: 403,
    error: `This link is for the wallet ending ${walletTail(opened.owner.addr)}. Switch to that wallet and sign again.`,
  };
}

/** What the page says it does, in one line. */
export async function actTitle(sql: Sql, opened: OpenedAct): Promise<string> {
  const host = hostOf(opened.api);
  switch (opened.act.action) {
    case "ownership":
      return `Sign to prove you own ${host}`;
    case "key":
      return `Add the key for ${host}`;
    case "publish": {
      const pack = await getPack(sql, opened.api.id);
      return pack
        ? `Sign to publish ${host} at ${formatTusdm(pack.priceMicros)} tUSDM for ${pack.calls} calls`
        : `Sign to publish ${host}`;
    }
  }
}

/**
 * The lines the owner signs for a key or publish link (lib/session.ts issueActChallenge): the action and, to
 * publish, the price. Computed again when the signature arrives, so a price changed in between is refused.
 */
export async function actLines(sql: Sql, opened: OpenedAct): Promise<string[]> {
  return [await actTitle(sql, opened), `API: ${opened.api.id}`];
}

/** Where the key goes, as the OpenAPI file says, for the page's key field. */
export async function actKeyHint(sql: Sql, opened: OpenedAct): Promise<AuthHint | null> {
  return opened.act.action === "publish" ? null : getAuthHint(sql, opened.api.id);
}
