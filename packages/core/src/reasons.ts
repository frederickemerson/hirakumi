/**
 * Fixed reasons the gateway gives when an API's key is the problem. They go into probe health reasons (and so the
 * Down banner and the seller's message) and into a buyer's 422 reasons, so they never name the key itself.
 */

/** The upstream answered 401 to a call that carried the seller's key. */
export const KEY_REFUSED_TEXT = "The API refused its key (HTTP 401). The seller should check or replace the key.";
/** The upstream answered 403 to a call that carried the seller's key. */
export const KEY_FORBIDDEN_TEXT = "The API refused access (HTTP 403): the key's permissions, an IP allowlist or a firewall.";
/** A keyed API sent a compressed answer, which can't be checked for its key, so it was withheld. */
export const KEY_UNSCANNABLE_TEXT =
  "The API sent a compressed answer (Content-Encoding), which can't be checked for its key, so it was withheld.";
/**
 * The gateway can't read any API's key (no private key, or one that doesn't match the public key). It still turns
 * the API Down, so nothing unusable is sold, but it is Hirakumi's problem: the seller is not messaged about it.
 */
export const OPERATOR_KEYS_UNAVAILABLE =
  "Hirakumi can't read API keys right now. This is our problem, not yours; sales are paused until we fix it.";

/** The reason text of a health_events.reasons entry ({ op, reason, since } or a plain string), else null. */
function reasonText(r: unknown): string | null {
  if (typeof r === "string") return r;
  if (r && typeof r === "object" && typeof (r as { reason?: unknown }).reason === "string") return (r as { reason: string }).reason;
  return null;
}

/**
 * True when health_events.reasons is a non-empty array whose every reason is OPERATOR_KEYS_UNAVAILABLE: the API is
 * Down for Hirakumi's reason only, so the seller is not messaged.
 */
export function isOperatorOnly(reasons: unknown): boolean {
  return Array.isArray(reasons) && reasons.length > 0 && reasons.every((r) => reasonText(r) === OPERATOR_KEYS_UNAVAILABLE);
}
