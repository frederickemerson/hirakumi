import {
  jwtExpiry, keyAppearsIn, renderPreset, sealUpstreamBag, sealUpstreamSecret, textLeaksAny, upstreamSecretHint, UpstreamAuthError,
  validateUpstreamAuth, valueLooksLikeKey, type RenderedPreset, type StoredUpstreamAuth,
} from "@hirakumi/core";
import { env } from "@/lib/env";
import { checkKey, reloadQuietly, type KeyCheck } from "@/lib/gateway";
import { errorJson, json, readJson, type ApiRouteContext } from "@/lib/http";
import { updatingResponse } from "@/lib/repo/schema";
import { clearUpstreamAuth, publicExampleTexts, retryFailedQa, setUpstreamAuth, type UpstreamAuthView } from "@/lib/repo/upstream-auth";
import { loadOwnedApi } from "@/lib/route-helpers";

const RETIRED = "This API was removed from the market, so its key can't change.";
const GONE = "This API was removed or deleted while you saved, so its key wasn't saved. Reload the page.";
const NOT_SET_UP = "Adding a key isn't set up on Hirakumi right now. Try again later.";
const KEY_IS_PUBLIC =
  "This key appears in your example requests, your OpenAPI file or your endpoints' examples, where buyers can see it. " +
  "Remove the API, list it again without the key in them, then add the key here.";
const NO_BAGS = "Keys made of several parts can't be saved on Hirakumi yet. Use a single header or query parameter for now.";
const NO_BASIC_PASSWORD =
  "HTTP Basic with a password can't be saved on Hirakumi yet. Leave the password empty if your API takes the key as the user name, " +
  "or use a single header for now.";
const KEY_REFUSED_ERROR = "Your API refused this key. Check it, or save it anyway.";
const EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The key the gateway sends to the seller's API. It is sealed here to the gateway's public key, so only the
 * gateway can open it, and bound to this API's id, where it goes and the API's address (origin and path prefix,
 * final from the endpoints step on). If the address changes later the gateway refuses the key until it is saved
 * again. Answers carry where it goes and its last 4 characters, never the key itself or the sealed copy.
 *
 * The body is one header or query parameter ({ in, name, value }), or a preset ({ preset, fields }, see
 * renderPreset). One value is sealed as before (hks2); several parts as a bag (hks3), only with UPSTREAM_AUTH_V3 on.
 * Before saving, the gateway makes one real call with the sealed key (checkKey). A key the API refuses (401 or 403)
 * is not saved unless saveAnyway is true; anything else saves, with the check in the answer.
 */
export async function POST(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const loaded = await loadOwnedApi(req, ctx);
  if (loaded instanceof Response) return loaded;
  const { api, sql, session } = loaded;
  const updating = await updatingResponse(sql);
  if (updating) return updating;
  if (api.state === "retired") return errorJson(409, RETIRED);
  const body = await readJson(req);
  if (!body) return errorJson(400, "Send where the key goes, its name and the key.");
  let rendered: RenderedPreset;
  try {
    rendered = body.preset === undefined
      ? { kind: "hks2", credential: validateUpstreamAuth({ in: body.in, name: body.name, value: body.value }) }
      : renderPreset(body.preset, body.fields);
  } catch (e) {
    if (e instanceof UpstreamAuthError) return errorJson(400, e.message);
    throw e;
  }
  if (rendered.kind === "hks3" && !env.upstreamAuthV3()) return errorJson(409, body.preset === "basic" ? NO_BASIC_PASSWORD : NO_BAGS);
  // The only moment the server holds the key in plain text: a key buyers can already read in the examples would be
  // public whatever the gateway does with it. The exact key and its encodings (keyAppearsIn), not a guess by name.
  // A bag's secrets are looked for as they are, like the gateway's leak list: a Basic user name is public, so it
  // isn't guessed out of the Basic value. Fixed text (a version header) is public by choice, so it is not looked for.
  const texts = await publicExampleTexts(sql, api.id);
  const isPublic = rendered.kind === "hks2"
    ? keyAppearsIn(rendered.credential.value, texts)
    : texts.some((t) => textLeaksAny(t, secretsOf(rendered)));
  if (isPublic) return errorJson(400, KEY_IS_PUBLIC);
  const publicKey = env.upstreamAuthPublicKey();
  if (!publicKey) return errorJson(503, NOT_SET_UP);
  let stored: StoredUpstreamAuth;
  try {
    stored = seal(publicKey, api, rendered);
  } catch (e) {
    console.error(`sealing an upstream key failed for ${api.id} (check UPSTREAM_AUTH_PUBLIC_KEY)`, e);
    return errorJson(503, NOT_SET_UP);
  }
  const check = await checkKey(api.id, stored);
  // The gateway couldn't open what was sealed here: its private key doesn't match this public key.
  if (check && !check.opened) return errorJson(503, NOT_SET_UP);
  if (check && (check.class === "refused" || check.class === "forbidden") && body.saveAnyway !== true) {
    return json({ error: KEY_REFUSED_ERROR, code: "KEY_REFUSED", check }, 409);
  }
  // Retired or deleted after this request read it: the key is not written back.
  if (!(await setUpstreamAuth(sql, { apiId: api.id, sellerId: session.sellerId }, stored))) return errorJson(409, GONE);
  await reloadQuietly(api.id);
  await retryFailedQa(sql, api.id);
  const warnings = warningsFor(rendered);
  const answer: UpstreamAuthView & { check?: KeyCheck; warnings?: string[] } = viewOf(stored);
  if (check) answer.check = check;
  if (warnings.length > 0) answer.warnings = warnings;
  return json(answer);
}

/** Every text of a bag that must stay secret: its leak list and every value that isn't fixed text. */
function secretsOf(r: Extract<RenderedPreset, { kind: "hks3" }>): string[] {
  return [...new Set([...r.leak, ...r.values.filter((_, i) => !r.fixed.includes(i))])];
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

/** The row to store: hks2 as before, or a bag whose parts carry a hint for each secret part and flag fixed text. */
function seal(publicKey: string, api: { id: string; origin: string; pathPrefix: string }, r: RenderedPreset): StoredUpstreamAuth {
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
function viewOf(stored: StoredUpstreamAuth): UpstreamAuthView {
  if ("parts" in stored) {
    return { parts: stored.parts.map((p) => ({ in: p.in, name: p.name, hint: p.hint, ...(p.fixed ? { fixed: true as const } : {}) })) };
  }
  return { in: stored.in, name: stored.name, hint: stored.hint };
}

/** Things worth knowing that don't stop a save: fixed text that looks like a key, a token that expires soon. */
function warningsFor(r: RenderedPreset): string[] {
  const warnings: string[] = [];
  const sent = r.kind === "hks2" ? [{ name: r.credential.name, value: r.credential.value, fixed: false }]
    : r.parts.map((p, i) => ({ name: p.name, value: r.values[i], fixed: r.fixed.includes(i) }));
  for (const part of sent) {
    if (part.fixed) {
      if (valueLooksLikeKey(part.value)) {
        warnings.push(`The fixed text in ${part.name} looks like a key. Fixed text isn't withheld if your API repeats it, so mark it as a secret if it is one.`);
      }
      continue;
    }
    const expires = jwtExpiry(part.value);
    if (expires && expires.getTime() - Date.now() < EXPIRY_WARNING_MS) {
      warnings.push(
        `The key in ${part.name} is a token that ${expires.getTime() <= Date.now() ? "expired" : "expires"} on ${expires.toISOString().slice(0, 10)}. ` +
        "Once it expires your API will refuse it and sales pause, so save a key that doesn't expire.",
      );
    }
  }
  return warnings;
}

export async function DELETE(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const loaded = await loadOwnedApi(req, ctx);
  if (loaded instanceof Response) return loaded;
  const { api, sql } = loaded;
  const updating = await updatingResponse(sql);
  if (updating) return updating;
  if (api.state === "retired") return errorJson(409, RETIRED);
  // No key was stored: nothing changes, so nothing reloads and failed test calls don't run again.
  if (await clearUpstreamAuth(sql, api.id)) {
    await reloadQuietly(api.id);
    await retryFailedQa(sql, api.id);
  }
  return json({ removed: true });
}
