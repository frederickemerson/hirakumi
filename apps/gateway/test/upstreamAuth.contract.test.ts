import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { generateUpstreamAuthKeys, sealUpstreamSecret, upstreamSecretHint, validateUpstreamAuth } from "@hirakumi/core";
import { loadApiBundle } from "@hirakumi/db";
import { createPool } from "../../coworker/src/db";
import { parseOpenApi } from "../../coworker/src/openapi/parse";
import { finishStep } from "../../coworker/src/steps";
import { getAuthHint, getUpstreamAuth, setUpstreamAuth } from "../../web/lib/repo/upstream-auth";
import { openCredential } from "../src/registry";
import { makeHarness, type Harness } from "./helpers";

/**
 * The whole key path across the three apps, with each app's own code where it can run here: the coworker reads
 * the key's place from the OpenAPI file and saves it as the parse step's authHint, the web app reads that hint,
 * seals the seller's key and stores the row, and the gateway opens the row and sends the key upstream.
 */
const BEARER_SPEC = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Price", version: "1" },
  servers: [{ url: "https://api.example.com" }],
  components: { securitySchemes: { token: { type: "http", scheme: "bearer" } } },
  security: [{ token: [] }],
  paths: {
    "/price": {
      get: {
        operationId: "getPrice",
        parameters: [{ name: "symbol", in: "query", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "ok" } },
      },
    },
  },
});
const KEY = "sk_live_0123456789abcdefWXYZ";
const keys = generateUpstreamAuthKeys();
const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://hirakumi:hirakumi@localhost:5432/hirakumi";
const internal = { authorization: "Bearer internal-test-token-0123456789" };

describe("upstream key contract: coworker hint, web sealing, gateway opening", () => {
  let h: Harness;
  afterEach(async () => { await h.close(); });

  it("a bearer key goes from the OpenAPI file to the seller's form to the upstream call for the same API", async () => {
    h = await makeHarness({ config: { upstreamAuthPrivateKey: keys.privateKey } });
    const apiId = h.seeded.apiId;

    // Coworker: the parse step output carries authHint, saved through the coworker's own pool and finishStep.
    const parsed = await parseOpenApi(BEARER_SPEC);
    expect(parsed.authHint).toEqual({ in: "header", name: "Authorization", prefix: "Bearer " });
    const pool = createPool(TEST_URL, h.db.schema);
    try {
      await finishStep(pool, apiId, "parse", { title: parsed.title, authHint: parsed.authHint });
    } finally {
      await pool.end();
    }

    // Web: the form prefills from the hint and adds the prefix; the route checks, seals and stores the row.
    const hint = await getAuthHint(h.sql, apiId);
    expect(hint).toEqual({ in: "header", name: "Authorization", prefix: "Bearer " });
    const credential = validateUpstreamAuth({ in: hint!.in, name: hint!.name, value: `${hint!.prefix}${KEY}` });
    expect(await setUpstreamAuth(h.sql, { apiId, sellerId: h.seeded.sellerId }, {
      in: credential.in, name: credential.name, sealed: sealUpstreamSecret(keys.publicKey, apiId, credential.value),
      hint: upstreamSecretHint(credential.value),
    })).toBe(true);
    expect(await getUpstreamAuth(h.sql, apiId)).toEqual({ in: "header", name: "Authorization", hint: "WXYZ" });

    // Gateway: the row loads as a jsonb object and opens for this API id only.
    const bundle = await loadApiBundle(h.sql, apiId);
    expect(typeof bundle!.api.upstream_auth).toBe("object");
    expect(openCredential(bundle!.api, keys.privateKey))
      .toEqual({ credential: { in: "header", name: "Authorization", value: `Bearer ${KEY}` }, credentialError: null });
    expect(openCredential({ ...bundle!.api, id: "api_other" }, keys.privateKey).credential).toBeNull();

    // After the web app asks for a reload, the next call carries the key.
    await request(h.app).post(`/internal/apis/${apiId}/reload`).set(internal).expect(200);
    const p = await request(h.app).post(`/internal/preview/${apiId}/getPrice`).set(internal).send({ input: { symbol: "ADA" } });
    expect(p.status).toBe(200);
    expect(h.stub.lastHeaders()?.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(p.body)).not.toContain(KEY);
  });
});
