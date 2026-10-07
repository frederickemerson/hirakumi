import { normalizeSamplesBase, parseSampleLinesWithWarnings, SampleError } from "@hirakumi/core";
import { getSql } from "@/lib/db";
import { env } from "@/lib/env";
import { errorJson, json, readJson, requireSeller } from "@/lib/http";
import { createApi, createApiForTask, findCoworkerTask, LISTED_BY_OTHER, type ApiInput } from "@/lib/repo/apis";
import { updatingResponse } from "@/lib/repo/schema";
import { validateApiName, validateOpenApiUrl, ValidationError } from "@/lib/validate";

/**
 * An OpenAPI link, or (no OpenAPI file) a base URL plus example requests, checked now so mistakes show at once.
 * The OpenAPI file may be hosted anywhere, so its origin is only a placeholder: the parse step sets the API's
 * origin and path from servers[0]. A samples API has no file (openapi_url null) and its base is final.
 */
function readIntake(body: Record<string, unknown>, sellerId: string): { input: ApiInput; keyWarnings: string[] } {
  if (body.mode === "samples") {
    const { base, origin, hostname } = normalizeSamplesBase(body.baseUrl, env.allowInsecureUpstream());
    const lines = typeof body.samples === "string" ? body.samples.trim() : "";
    if (lines.length > 20_000) throw new SampleError("The example requests are too long.");
    // Lines that may hold a key are taken with a warning: a name or a value's shape can't prove a key. The exact key
    // is refused when the seller saves it (upstream-auth route).
    const { warnings } = parseSampleLinesWithWarnings(lines);
    return { input: { sellerId, name: validateApiName(body.name, hostname), origin, openapiUrl: null, samples: { base, lines } }, keyWarnings: warnings };
  }
  const { url, origin, hostname } = validateOpenApiUrl(body.openapiUrl, env.allowInsecureUpstream());
  return { input: { sellerId, name: validateApiName(body.name, hostname), origin, openapiUrl: url }, keyWarnings: [] };
}

const SAMPLES_OFF = "Listing an API from example requests isn't available yet. Paste the link to your OpenAPI description instead.";

export async function POST(req: Request): Promise<Response> {
  const session = await requireSeller(req);
  if (session instanceof Response) return session;
  const body = await readJson(req);
  if (!body) return errorJson(400, "Paste the link to your OpenAPI description, or your base URL and example requests.");
  if (body.mode === "samples") {
    // Behind SAMPLES_INTAKE until the coworker that reads example requests runs (lib/env.ts), and needs migrations 0014 and 0015.
    if (!env.samplesIntake()) return errorJson(400, SAMPLES_OFF);
    const updating = await updatingResponse(getSql());
    if (updating) return updating;
  }
  try {
    const { input, keyWarnings } = readIntake(body, session.sellerId);
    let result: Awaited<ReturnType<typeof createApi>>;
    if (typeof body.setupToken === "string" && body.setupToken) {
      const task = await findCoworkerTask(getSql(), body.setupToken);
      if (!task) return errorJson(400, "This setup link isn't valid any more. Open the latest link from your Sokosumi task.");
      const forTask = await createApiForTask(getSql(), input, task);
      if ("claimedByOther" in forTask) {
        return errorJson(403, "This setup link is already in use by another wallet. Sign in with that wallet, or start a new task in Sokosumi.");
      }
      if ("linkedElsewhere" in forTask) {
        return errorJson(409, "Your Sokosumi account is linked to another wallet. Open your setup link again to move it to this wallet.");
      }
      result = forTask;
    } else {
      result = await createApi(getSql(), input);
    }
    if ("takenByOther" in result) return errorJson(409, LISTED_BY_OTHER);
    const { api, created } = result;
    return json({ apiId: api.id, state: api.state, name: api.name, created, keyWarnings }, created ? 201 : 200);
  } catch (e) {
    if (e instanceof ValidationError || e instanceof SampleError) return errorJson(400, e.message);
    throw e;
  }
}
