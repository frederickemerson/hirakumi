import { getSql } from "@/lib/db";
import { env } from "@/lib/env";
import { errorJson, json, readJson, requireSeller } from "@/lib/http";
import { createApi, createApiForTask, findCoworkerTask } from "@/lib/repo/apis";
import { validateApiName, validateOpenApiUrl, ValidationError } from "@/lib/validate";

export async function POST(req: Request): Promise<Response> {
  const session = requireSeller(req);
  if (session instanceof Response) return session;
  const body = await readJson(req);
  if (!body) return errorJson(400, "Paste the link to your OpenAPI description.");
  try {
    const { url, origin, hostname } = validateOpenApiUrl(body.openapiUrl, env.allowInsecureUpstream());
    const name = validateApiName(body.name, hostname);
    const input = { sellerId: session.sellerId, name, origin, openapiUrl: url };
    let result: Awaited<ReturnType<typeof createApi>>;
    if (typeof body.setupToken === "string" && body.setupToken) {
      const task = await findCoworkerTask(getSql(), body.setupToken);
      if (!task) return errorJson(400, "This setup link isn't valid any more. Open the latest link from your Sokosumi task.");
      result = await createApiForTask(getSql(), input, task);
    } else {
      result = await createApi(getSql(), input);
    }
    const { api, created } = result;
    return json({ apiId: api.id, state: api.state, created }, created ? 201 : 200);
  } catch (e) {
    if (e instanceof ValidationError) return errorJson(400, e.message);
    throw e;
  }
}
