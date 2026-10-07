import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import {
  generateUpstreamAuthKeys, renderPreset, sealUpstreamBag, sealUpstreamSecret, upstreamSecretHint, validateUpstreamAuth, type StoredUpstreamAuth,
} from "@hirakumi/core";
import { loadApiBundle } from "@hirakumi/db";
import { createPool } from "../../coworker/src/db";
import { parseOpenApi } from "../../coworker/src/openapi/parse";
import { finishStep } from "../../coworker/src/steps";
import { parseKeyCheck } from "../../web/lib/gateway";
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
      in: credential.in, name: credential.name, sealed: sealUpstreamSecret(keys.publicKey, { apiId, in: credential.in, name: credential.name, origin: h.stub.origin, pathPrefix: "/" }, credential.value),
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

/** Each preset as a seller fills it in. */
const PRESETS: [string, unknown][] = [
  ["single", { in: "query", name: "api_key", value: KEY }],
  ["bearer", { key: KEY }],
  ["bearer", { key: KEY, scheme: "Token", header: "X-Auth" }],
  ["basic", { username: KEY }],
  ["basic", { username: "alice", password: "pw-0123456789xyz" }],
  ["twoHeaders", { rows: [{ in: "header", name: "apikey", value: KEY }, { in: "header", name: "Authorization", value: KEY, scheme: "Bearer" }] }],
  ["keyPlusFixed", { rows: [{ in: "header", name: "X-API-Key", value: KEY }, { in: "header", name: "Notion-Version", value: "2022-06-28", fixed: true }] }],
  ["headerPlusQuery", { rows: [{ in: "header", name: "X-App-Id", value: "app-0123456789" }, { in: "query", name: "key", value: KEY }] }],
];

/** What the gateway must withhold whatever the leak list says, worked out here independently of core. */
function derived(value: string): string[] {
  const basic = /^Basic ([A-Za-z0-9+/=]+)$/.exec(value);
  if (basic) {
    const pair = Buffer.from(basic[1], "base64").toString();
    const password = pair.slice(pair.indexOf(":") + 1);
    return [password, pair].filter((x) => x.length >= 8 && password.length > 0);
  }
  const scheme = /^(?:Bearer|Token) (.+)$/.exec(value);
  return scheme ? [scheme[1]] : [];
}

describe("upstream key contract: every preset the web app seals opens on the gateway", () => {
  let h: Harness;
  afterEach(async () => { await h.close(); });

  it("with the same parts, and a leak set covering the web's list and what the gateway derives", async () => {
    h = await makeHarness({ config: { upstreamAuthPrivateKey: keys.privateKey } });
    const { apiId, sellerId } = h.seeded;
    const at = { origin: h.stub.origin, pathPrefix: "/" };
    for (const [preset, fields] of PRESETS) {
      const label = `${preset} ${JSON.stringify(fields)}`;
      const r = renderPreset(preset, fields);
      // Web: seal the rendered key or bag for this API and store it as the route does.
      let stored: StoredUpstreamAuth;
      if (r.kind === "hks2") {
        const c = r.credential;
        stored = { in: c.in, name: c.name, sealed: sealUpstreamSecret(keys.publicKey, { apiId, in: c.in, name: c.name, ...at }, c.value), hint: upstreamSecretHint(c.value) };
      } else {
        const hints = r.values.map((v, i) => (r.fixed.includes(i) ? "" : upstreamSecretHint(v)));
        stored = { v: 3, parts: r.parts.map((p, i) => ({ ...p, hint: hints[i] })), sealed: sealUpstreamBag(keys.publicKey, { apiId, parts: r.parts, ...at }, r) };
      }
      expect(await setUpstreamAuth(h.sql, { apiId, sellerId }, stored), label).toBe(true);

      // Gateway: the stored row opens to exactly what was rendered.
      const access = openCredential((await loadApiBundle(h.sql, apiId))!.api, keys.privateKey);
      expect(access.credentialError, label).toBeNull();
      if (r.kind === "hks2") {
        expect(access, label).toStrictEqual({ credential: r.credential, credentialError: null });
        continue;
      }
      expect(access.credential, label).toBeNull();
      expect(access.auth?.parts, label).toEqual(r.parts.map((p, i) => ({ ...p, value: r.values[i] })));
      const secrets = r.values.filter((_, i) => !r.fixed.includes(i));
      const leakParts = new Set(access.auth?.leakParts);
      for (const x of [...r.leak, ...secrets, ...secrets.flatMap(derived)]) expect(leakParts.has(x), `${label}: ${x}`).toBe(true);
      for (const i of r.fixed) expect(leakParts.has(r.values[i]), label).toBe(false);
    }
  });
});

describe("upstream key contract: the gateway's key check answers in the shape the web app reads", () => {
  let h: Harness;
  afterEach(async () => { await h.close(); });

  /** Saves a header key for the harness's API and returns a function posting one check, as the web app does. */
  async function keyedCheck(): Promise<(body?: object) => Promise<request.Response>> {
    h = await makeHarness({ config: { upstreamAuthPrivateKey: keys.privateKey } });
    const apiId = h.seeded.apiId;
    const ctx = { apiId, in: "header" as const, name: "X-API-Key", origin: h.stub.origin, pathPrefix: "/" };
    await h.sql`update apis set upstream_auth = ${h.sql.json({ in: "header", name: "X-API-Key", hint: "", sealed: sealUpstreamSecret(keys.publicKey, ctx, KEY) })} where id = ${apiId}`;
    return (body = {}) => request(h.app).post(`/internal/apis/${apiId}/check-key`).set(internal).send(body);
  }
  /** The web parser keeps every field of the gateway's answer, unchanged. */
  const parsedClass = (r: request.Response) => {
    expect(r.status).toBe(200);
    expect(parseKeyCheck(r.body)).toStrictEqual(r.body);
    return r.body.class as string;
  };

  it("for every class a check can end in", async () => {
    const seen: string[] = [];
    let check = await keyedCheck();
    seen.push(parsedClass(await check()));
    h.stub.setMode("echo");
    seen.push(parsedClass(await check()));
    h.stub.setMode("error500");
    seen.push(parsedClass(await check()));
    for (const status of [401, 403, 429]) {
      h.stub.setFile("/price", "{}", { status });
      seen.push(parsedClass(await check()));
    }
    await h.close();

    check = await keyedCheck();
    h.stub.setMode("slow");
    seen.push(parsedClass(await check()));
    h.stub.setMode("ok");
    await h.sql`delete from rules where operation_id = ${h.seeded.operationId}`;
    seen.push(parsedClass(await check()));
    const notOpened = await check({ stored: { in: "header", name: "X-API-Key", hint: "", sealed: "hks2.garbage" } });
    expect(parsedClass(notOpened)).toBe("unchecked");
    expect(notOpened.body.opened).toBe(false);

    expect(seen).toEqual(["ok", "echoed", "unclear", "refused", "forbidden", "rate_limited", "timeout", "accepted_unverified"]);
  });
});
