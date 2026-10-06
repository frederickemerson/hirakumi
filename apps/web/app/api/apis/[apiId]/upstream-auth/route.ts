import { sealUpstreamSecret, upstreamSecretHint, UpstreamAuthError, validateUpstreamAuth } from "@hirakumi/core";
import { env } from "@/lib/env";
import { reloadQuietly } from "@/lib/gateway";
import { errorJson, json, readJson, type ApiRouteContext } from "@/lib/http";
import { clearUpstreamAuth, retryFailedQa, setUpstreamAuth } from "@/lib/repo/upstream-auth";
import { loadOwnedApi } from "@/lib/route-helpers";

const RETIRED = "This API was removed from the market, so its key can't change.";
const GONE = "This API was removed or deleted while you saved, so its key wasn't saved. Reload the page.";
const NOT_SET_UP = "Adding a key isn't set up on Hirakumi right now. Try again later.";

/**
 * The key the gateway sends to the seller's API. It is sealed here to the gateway's public key, so only the
 * gateway can open it, and bound to this API's id. Answers carry where it goes and its last 4 characters, never
 * the key itself or the sealed copy.
 */
export async function POST(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const loaded = await loadOwnedApi(req, ctx);
  if (loaded instanceof Response) return loaded;
  const { api, sql, session } = loaded;
  if (api.state === "retired") return errorJson(409, RETIRED);
  const body = await readJson(req);
  if (!body) return errorJson(400, "Send where the key goes, its name and the key.");
  let credential;
  try {
    credential = validateUpstreamAuth({ in: body.in, name: body.name, value: body.value });
  } catch (e) {
    if (e instanceof UpstreamAuthError) return errorJson(400, e.message);
    throw e;
  }
  const publicKey = env.upstreamAuthPublicKey();
  if (!publicKey) return errorJson(503, NOT_SET_UP);
  let sealed: string;
  try {
    sealed = sealUpstreamSecret(publicKey, api.id, credential.value);
  } catch (e) {
    console.error(`sealing an upstream key failed for ${api.id} (check UPSTREAM_AUTH_PUBLIC_KEY)`, e);
    return errorJson(503, NOT_SET_UP);
  }
  const hint = upstreamSecretHint(credential.value);
  const stored = await setUpstreamAuth(sql, { apiId: api.id, sellerId: session.sellerId }, { in: credential.in, name: credential.name, sealed, hint });
  // Retired or deleted after this request read it: the key is not written back.
  if (!stored) return errorJson(409, GONE);
  await reloadQuietly(api.id);
  await retryFailedQa(sql, api.id);
  return json({ in: credential.in, name: credential.name, hint });
}

export async function DELETE(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const loaded = await loadOwnedApi(req, ctx);
  if (loaded instanceof Response) return loaded;
  const { api, sql } = loaded;
  if (api.state === "retired") return errorJson(409, RETIRED);
  // No key was stored: nothing changes, so nothing reloads and failed test calls don't run again.
  if (await clearUpstreamAuth(sql, api.id)) {
    await reloadQuietly(api.id);
    await retryFailedQa(sql, api.id);
  }
  return json({ removed: true });
}
