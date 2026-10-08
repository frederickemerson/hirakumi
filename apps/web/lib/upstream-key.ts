import {
  keyAppearsIn, renderPreset, sealUpstreamBag, sealUpstreamSecret, textLeaksAny, upstreamSecretHint, validateUpstreamAuth,
  validateUpstreamBag, type RenderedPreset, type StoredUpstreamAuth,
} from "@hirakumi/core";
import type { UpstreamAuthView } from "@/lib/repo/upstream-auth";

/**
 * What the seller typed for a key, rendered: one header or query parameter ({ in, name, value }) or a preset
 * ({ preset, fields }, see renderPreset). Throws UpstreamAuthError with a message for the seller.
 */
export function renderKeyBody(body: Record<string, unknown>): RenderedPreset {
  return body.preset === undefined
    ? { kind: "hks2", credential: validateUpstreamAuth({ in: body.in, name: body.name, value: body.value }) }
    : renderPreset(body.preset, body.fields);
}

/**
 * True when a secret of the key already appears in texts buyers can read (examples, the OpenAPI file). One key: the
 * exact key and its encodings (keyAppearsIn). A bag: exactly what the gateway withholds (validateUpstreamBag's
 * leakParts), so the secrets it derives itself (the key after "Bearer", a Basic password and pair) count too. A Basic
 * user name and fixed text (a version header) are public by choice, so they are not looked for.
 */
export function keyIsPublic(r: RenderedPreset, texts: readonly (string | null | undefined)[]): boolean {
  if (r.kind === "hks2") return keyAppearsIn(r.credential.value, texts);
  const { leakParts } = validateUpstreamBag(r.parts, { values: r.values, fixed: r.fixed, leak: r.leak });
  return texts.some((t) => textLeaksAny(t, leakParts));
}

/**
 * The last 4 characters of the key itself, not of what is sent: "Bearer " in front of a short key would otherwise
 * lift it past upstreamSecretHint's 16 characters and show most of it. So the hint comes from the token after the
 * scheme word, and a Basic value has none (its end is the end of the base64 password).
 */
function secretHint(value: string): string {
  if (/^basic\s/i.test(value.trim())) return "";
  return upstreamSecretHint(value.trim().split(/\s+/).pop() ?? "");
}

/**
 * The row to store, sealed for the gateway and bound to this API at this address (origin and path prefix): hks2 as
 * before, or a bag whose parts carry a hint for each secret part and flag fixed text.
 */
export function sealKey(publicKey: string, api: { id: string; origin: string; pathPrefix: string }, r: RenderedPreset): StoredUpstreamAuth {
  const where = { apiId: api.id, origin: api.origin, pathPrefix: api.pathPrefix };
  if (r.kind === "hks2") {
    const { credential: c } = r;
    const sealed = sealUpstreamSecret(publicKey, { ...where, in: c.in, name: c.name }, c.value);
    return { in: c.in, name: c.name, sealed, hint: secretHint(c.value) };
  }
  const sealed = sealUpstreamBag(publicKey, { ...where, parts: r.parts }, { values: r.values, fixed: r.fixed, leak: r.leak });
  // A fixed part is flagged (display only, not sealed) and has no hint.
  const parts = r.parts.map((p, i) =>
    (r.fixed.includes(i) ? { in: p.in, name: p.name, hint: "", fixed: true as const } : { in: p.in, name: p.name, hint: secretHint(r.values[i]) }));
  return { v: 3, parts, sealed };
}

/** What the seller sees of a stored key (the same shape getUpstreamAuth reads back). */
export function viewOf(stored: StoredUpstreamAuth): UpstreamAuthView {
  if ("parts" in stored) {
    return { parts: stored.parts.map((p) => ({ in: p.in, name: p.name, hint: p.hint, ...(p.fixed ? { fixed: true as const } : {}) })) };
  }
  return { in: stored.in, name: stored.name, hint: stored.hint };
}
