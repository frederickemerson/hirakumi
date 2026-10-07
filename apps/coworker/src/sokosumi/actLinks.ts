import { ACT_PLACEHOLDER_RE, ACT_TOKEN_TTL_MINUTES, actPath, hashActToken, newActToken, newId, type ActAction } from "@hirakumi/core";
import type { Db } from "../db.js";
import { walletTail } from "./sellerActions.js";

/**
 * The one-time links of a Sokosumi task (apps/web /act/<token>, act_tokens). A message holds a placeholder per
 * link (core actPlaceholder); the outbox makes each token as it posts the comment, so the 30 minutes start then and
 * the plain token is never stored. The wallet named is the API owner's: the page only accepts its signature.
 */
export async function issueActToken(db: Db, apiId: string, action: ActAction): Promise<{ token: string; wallet: string } | null> {
  const { rows: [owner] } = await db.query<{ cardano_addr: string }>(
    `select s.cardano_addr from apis a join sellers s on s.id = a.seller_id where a.id = $1 and a.deleted_at is null`, [apiId]);
  if (!owner) return null;
  const token = newActToken();
  await db.query(
    `insert into act_tokens (id, token_hash, api_id, action, wallet, expires_at)
     values ($1, $2, $3, $4, $5, now() + make_interval(mins => $6))`,
    [newId("act"), hashActToken(token), apiId, action, owner.cardano_addr, ACT_TOKEN_TTL_MINUTES],
  );
  return { token, wallet: owner.cardano_addr };
}

/** Said in a comment that already offers the command (the help text), so it isn't offered twice. */
const LINK_WALLET = "Reply `link wallet`";

/**
 * The comment as posted: each placeholder becomes a fresh one-time link for the message's API, and the comment ends
 * with the wallet those links are for and how long they work. Without an API (or its owner) a placeholder becomes
 * a plain "reply for a link" note.
 */
export async function expandActLinks(db: Db, webBaseUrl: string, apiId: string | null, body: string): Promise<string> {
  const actions = [...body.matchAll(ACT_PLACEHOLDER_RE)].map((m) => m[1] as ActAction);
  if (actions.length === 0) return body;
  let wallet: string | null = null;
  const links = new Map<ActAction, string>();
  for (const action of new Set(actions)) {
    const made = apiId ? await issueActToken(db, apiId, action) : null;
    if (!made) continue;
    wallet = made.wallet;
    links.set(action, `${webBaseUrl}${actPath(made.token)}`);
  }
  const text = body.replace(ACT_PLACEHOLDER_RE, (_, a: ActAction) => links.get(a) ?? "(reply here for a new link)");
  if (!wallet) return text;
  const offer = body.includes(LINK_WALLET) ? "" : ` (Different wallet? ${LINK_WALLET}.)`;
  return `${text}\n\nSign with the wallet ending ${walletTail(wallet)}. The link works once, for ${ACT_TOKEN_TTL_MINUTES} minutes.${offer}`;
}
