import { UpstreamAuthError, type RenderedPreset, type StoredUpstreamAuth } from "@hirakumi/core";
import { sharedSuffixOf } from "@/app/apis/[apiId]/ownership/probe-dns";
import { env } from "@/lib/env";
import { GatewayError, getFrontDoorGateway } from "@/lib/gateway";
import { errorJson, json, readJson, type ApiRouteContext } from "@/lib/http";
import { frontDoorUpdatingResponse, updatingResponse } from "@/lib/repo/schema";
import { publicExampleTexts } from "@/lib/repo/upstream-auth";
import { loadOwnedApi } from "@/lib/route-helpers";
import { keyIsPublic, renderKeyBody, sealKey } from "@/lib/upstream-key";
import type { ApiState } from "@/lib/types";

/** From proven ownership on: the API's address is final and its ownership code is the one the new origin reuses. */
const READY: ReadonlySet<ApiState> = new Set(["ownership_verified", "rule_built", "priced", "registering", "live"]);

const NOT_SET_UP = "Adding a key isn't set up on Hirakumi right now. Try again later.";
const NO_BAGS = "Keys made of several parts can't be saved on Hirakumi yet. Use a single header or query parameter for now.";
const KEY_IS_PUBLIC =
  "This key appears in your example requests, your OpenAPI file or your endpoints' examples, where buyers can see it. Use another key.";

/**
 * Step one of the front door: the seller's API at its second hostname (origin.example.com), with its key. The key
 * is sealed here for the new origin (only the gateway can open it), then the gateway checks the _hirakumi TXT
 * record at both hostnames and makes one test call per endpoint there. Only when all pass does the API move: the
 * gateway calls the new origin, and the old hostname waits for the seller's DNS change.
 */
export async function POST(req: Request, ctx: ApiRouteContext): Promise<Response> {
  const loaded = await loadOwnedApi(req, ctx);
  if (loaded instanceof Response) return loaded;
  const { api, sql } = loaded;
  const updating = (await updatingResponse(sql)) ?? (await frontDoorUpdatingResponse(sql));
  if (updating) return updating;
  if (!READY.has(api.state)) return errorJson(409, "The front door opens once you have proven you own this API.");
  const body = await readJson(req);
  if (!body) return errorJson(400, "Send the new origin and your API's key.");
  let origin: URL;
  try {
    origin = new URL(String(body.origin ?? "").trim());
  } catch {
    return errorJson(400, "Give the new origin as a URL, like https://origin.example.com.");
  }
  if (origin.protocol !== "https:") return errorJson(400, "The new origin must start with https://.");
  const suffix = sharedSuffixOf(origin.hostname);
  if (suffix) {
    return errorJson(400, `${origin.hostname} is on ${suffix}, a platform's shared domain where you can't add the TXT record. Use a hostname on your own domain.`);
  }
  // The key as the upstream-auth route takes it: one header or query parameter, or a preset (a key in several parts).
  const key = (body.key && typeof body.key === "object" ? body.key : {}) as Record<string, unknown>;
  let rendered: RenderedPreset;
  try {
    rendered = renderKeyBody(key);
  } catch (e) {
    if (e instanceof UpstreamAuthError) return errorJson(400, e.message);
    throw e;
  }
  if (rendered.kind === "hks3" && !env.upstreamAuthV3()) return errorJson(409, NO_BAGS);
  if (keyIsPublic(rendered, await publicExampleTexts(sql, api.id))) return errorJson(400, KEY_IS_PUBLIC);
  const publicKey = env.upstreamAuthPublicKey();
  if (!publicKey) return errorJson(503, NOT_SET_UP);
  let upstreamAuth: StoredUpstreamAuth;
  try {
    // Sealed for the new origin: the gateway refuses a key sealed for another address.
    upstreamAuth = sealKey(publicKey, { id: api.id, origin: origin.origin, pathPrefix: api.pathPrefix }, rendered);
  } catch (e) {
    console.error(`sealing an upstream key failed for ${api.id} (check UPSTREAM_AUTH_PUBLIC_KEY)`, e);
    return errorJson(503, NOT_SET_UP);
  }
  try {
    const r = await getFrontDoorGateway().switchOrigin(api.id, { origin: origin.origin, upstreamAuth });
    if (r.ok) return json(r);
    return json({
      error: r.detail, reason: r.error,
      ...(r.record ? { record: r.record } : {}), ...(r.code ? { code: r.code } : {}), ...(r.tests ? { tests: r.tests } : {}),
    }, r.status >= 400 && r.status < 500 ? r.status : 502);
  } catch (e) {
    if (e instanceof GatewayError) return errorJson(502, e.userMessage);
    throw e;
  }
}
