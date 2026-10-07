import { jwtExpiry, UpstreamAuthError, valueLooksLikeKey, type RenderedPreset, type StoredUpstreamAuth } from "@hirakumi/core";
import type { Sql } from "./db";
import { env } from "./env";
import { checkKey, reloadQuietly, type KeyCheck } from "./gateway";
import { errorJson, json } from "./http";
import { updatingResponse } from "./repo/schema";
import { publicExampleTexts, retryFailedQa, setUpstreamAuth, type UpstreamAuthView } from "./repo/upstream-auth";
import type { Api } from "./types";
import { keyIsPublic, renderKeyBody, sealKey, viewOf } from "./upstream-key";

export const RETIRED = "This API was removed from the market, so its key can't change.";
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
export async function saveUpstreamKey(sql: Sql, api: Api, sellerId: string, body: Record<string, unknown> | null): Promise<Response> {
  const updating = await updatingResponse(sql);
  if (updating) return updating;
  if (api.state === "retired") return errorJson(409, RETIRED);
  if (!body) return errorJson(400, "Send where the key goes, its name and the key.");
  let rendered: RenderedPreset;
  try {
    rendered = renderKeyBody(body);
  } catch (e) {
    if (e instanceof UpstreamAuthError) return errorJson(400, e.message);
    throw e;
  }
  if (rendered.kind === "hks3" && !env.upstreamAuthV3()) return errorJson(409, body.preset === "basic" ? NO_BASIC_PASSWORD : NO_BAGS);
  // The only moment the server holds the key in plain text: a key buyers can already read in the examples would be
  // public whatever the gateway does with it. The exact key and its encodings (keyAppearsIn), not a guess by name.
  // A bag's secrets are looked for as they are, like the gateway's leak list: a Basic user name is public, so it
  // isn't guessed out of the Basic value. Fixed text (a version header) is public by choice, so it is not looked for.
  if (keyIsPublic(rendered, await publicExampleTexts(sql, api.id))) return errorJson(400, KEY_IS_PUBLIC);
  const publicKey = env.upstreamAuthPublicKey();
  if (!publicKey) return errorJson(503, NOT_SET_UP);
  let stored: StoredUpstreamAuth;
  try {
    stored = sealKey(publicKey, api, rendered);
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
  if (!(await setUpstreamAuth(sql, { apiId: api.id, sellerId }, stored))) return errorJson(409, GONE);
  await reloadQuietly(api.id);
  await retryFailedQa(sql, api.id);
  const warnings = warningsFor(rendered);
  const answer: UpstreamAuthView & { check?: KeyCheck; warnings?: string[] } = viewOf(stored);
  if (check) answer.check = check;
  if (warnings.length > 0) answer.warnings = warnings;
  return json(answer);
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

