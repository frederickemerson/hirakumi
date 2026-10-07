import { createHash, randomBytes } from "node:crypto";

/**
 * One-time links for the wallet steps of a Sokosumi task (apps/web /act/<token>, table act_tokens, migration 0022).
 * The token only selects the action: the API owner's wallet signature on the page is the authority. Only its
 * SHA-256 hash is stored.
 *
 * - ownership: sign to prove you own the API (after the DNS record is found), with the optional key
 * - key: save or replace the API's key (sealed so only the gateway reads it)
 * - publish: sign to publish at the saved price
 */
export const ACT_ACTIONS = ["ownership", "key", "publish"] as const;
export type ActAction = (typeof ACT_ACTIONS)[number];
export const isActAction = (v: unknown): v is ActAction => (ACT_ACTIONS as readonly unknown[]).includes(v);

/** A link works this long after it was made. */
export const ACT_TOKEN_TTL_MINUTES = 30;

/** 256 random bits, URL-safe. */
export const newActToken = (): string => randomBytes(32).toString("base64url");
export const hashActToken = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");
/** A token as newActToken makes it, before anything is looked up. */
export const isActTokenShape = (token: unknown): token is string => typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);

export const actPath = (token: string) => `/act/${token}`;

/**
 * A coworker message names the link it needs as a placeholder, never the token: the outbox makes the token when it
 * posts the comment (so the 30 minutes start then, and no plain token is stored), and the dashboard log shows
 * ACT_PLACEHOLDER_TEXT instead.
 */
export const actPlaceholder = (action: ActAction) => `[[act:${action}]]`;
export const ACT_PLACEHOLDER_RE = /\[\[act:(ownership|key|publish)\]\]/g;
export const ACT_PLACEHOLDER_TEXT = "(the one-time signing link is in your Sokosumi task)";
