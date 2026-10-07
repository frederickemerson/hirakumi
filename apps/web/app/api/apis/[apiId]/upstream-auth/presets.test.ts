import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  generateUpstreamAuthKeys, openUpstreamBag, openUpstreamSecret, type StoredUpstreamAuth, type StoredUpstreamBag,
  type StoredUpstreamSecret,
} from "@hirakumi/core";
import { getSql } from "@/lib/db";
import { setGatewayForTests, type Gateway, type KeyCheck } from "@/lib/gateway";
import { getUpstreamAuth } from "@/lib/repo/upstream-auth";
import type { Api, Seller } from "@/lib/types";
import { resetDb } from "@/test/db";
import { seedApi, seedOperation, seedSeller } from "@/test/factories";
import { cookieFor, ctx, jsonRequest } from "@/test/requests";
import { POST } from "./route";

const KEY = "sk_live_0123456789abcdefWXYZ";
const keys = generateUpstreamAuthKeys();

let seller: Seller;
let api: Api;
let cookie: string;
let checkKey: ReturnType<typeof vi.fn<(apiId: string, stored?: StoredUpstreamAuth) => Promise<KeyCheck | null>>>;

function save(body: unknown, id = api.id) {
  return POST(jsonRequest(`/api/apis/${id}/upstream-auth`, { cookie, body }), ctx(id));
}
async function storedRow<T extends StoredUpstreamAuth = StoredUpstreamAuth>(id = api.id): Promise<T | null> {
  const [row] = await getSql()<{ upstreamAuth: T | null }[]>`select upstream_auth from apis where id = ${id}`;
  return row.upstreamAuth;
}
const where = () => ({ apiId: api.id, origin: api.origin, pathPrefix: api.pathPrefix });
const twoHeaders = {
  preset: "twoHeaders",
  fields: { rows: [{ in: "header", name: "apikey", value: KEY }, { in: "header", name: "Authorization", value: KEY, scheme: "Bearer" }] },
};
const keyPlusFixed = {
  preset: "keyPlusFixed",
  fields: { rows: [{ in: "header", name: "X-API-Key", value: KEY }, { in: "header", name: "Notion-Version", value: "2022-06-28", fixed: true }] },
};
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (exp: number) => `${b64url({ alg: "HS256" })}.${b64url({ sub: "seller", exp })}.c2lnbmF0dXJl`;

describe("upstream auth presets and the key check", () => {
  beforeEach(async () => {
    await resetDb();
    seller = await seedSeller();
    api = await seedApi(seller.id, "ownership_verified");
    cookie = cookieFor(seller);
    checkKey = vi.fn(async () => null);
    setGatewayForTests({ checkChallenge: vi.fn(), reloadApi: vi.fn(async () => undefined), getHealth: vi.fn(), getSettlement: vi.fn(), checkKey } as Gateway);
    vi.stubEnv("UPSTREAM_AUTH_PUBLIC_KEY", keys.publicKey);
    vi.stubEnv("UPSTREAM_AUTH_V3", "1");
  });
  afterEach(() => {
    setGatewayForTests(null);
    vi.unstubAllEnvs();
  });

  it("stores the Bearer preset and Basic with no password as one sealed value (hks2)", async () => {
    const bearer = await save({ preset: "bearer", fields: { key: KEY } });
    expect(bearer.status).toBe(200);
    expect(await bearer.json()).toEqual({ in: "header", name: "Authorization", hint: "WXYZ" });
    const row = (await storedRow<StoredUpstreamSecret>())!;
    expect(row.sealed.startsWith("hks2.")).toBe(true);
    expect(openUpstreamSecret(keys.privateKey, { ...where(), in: "header", name: "Authorization" }, row.sealed)).toBe(`Bearer ${KEY}`);

    expect((await save({ preset: "basic", fields: { username: KEY } })).status).toBe(200);
    const basic = (await storedRow<StoredUpstreamSecret>())!;
    expect(basic.sealed.startsWith("hks2.")).toBe(true);
    const sent = openUpstreamSecret(keys.privateKey, { ...where(), in: "header", name: "Authorization" }, basic.sealed);
    expect(sent).toBe(`Basic ${Buffer.from(`${KEY}:`).toString("base64")}`);
  });

  it("stores two headers as a bag (hks3) and reads back only where each part goes and its hint", async () => {
    const res = await save(twoHeaders);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("hks3");
    const view = { parts: [{ in: "header", name: "apikey", hint: "WXYZ" }, { in: "header", name: "Authorization", hint: "WXYZ" }] };
    expect(JSON.parse(text)).toEqual(view);

    const row = (await storedRow<StoredUpstreamBag>())!;
    expect(row).toMatchObject({ v: 3, ...view });
    expect(row.sealed.startsWith("hks3.")).toBe(true);
    const bag = openUpstreamBag(keys.privateKey, { ...where(), parts: [{ in: "header", name: "apikey" }, { in: "header", name: "Authorization" }] }, row.sealed);
    expect(bag.values).toEqual([KEY, `Bearer ${KEY}`]);
    expect(bag.leak).toEqual(expect.arrayContaining([KEY, `Bearer ${KEY}`]));

    const read = await getUpstreamAuth(getSql(), api.id);
    expect(read).toEqual(view);
    expect(JSON.stringify(read)).not.toContain("hks3");
  });

  it("marks fixed text without a hint and drops anything but where a part goes from the view", async () => {
    const view = { parts: [{ in: "header", name: "X-API-Key", hint: "WXYZ" }, { in: "header", name: "Notion-Version", hint: "", fixed: true }] };
    const res = await save(keyPlusFixed);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(view);
    expect(await getUpstreamAuth(getSql(), api.id)).toEqual(view);
    // A part carrying anything else (written by hand, say) still shows only its display fields.
    await getSql()`update apis set upstream_auth = jsonb_set(upstream_auth, '{parts,0,sealed}', '"hks3.secret"') where id = ${api.id}`;
    expect(JSON.stringify(await getUpstreamAuth(getSql(), api.id))).not.toContain("hks3");
  });

  it("takes the hint from the key, not from the word before it, and gives Basic none", async () => {
    const short = "abcdefghi"; // "Bearer abcdefghi" is 16 characters: its last 4 would be most of the key.
    expect(await (await save({ preset: "bearer", fields: { key: short } })).json()).toEqual({ in: "header", name: "Authorization", hint: "" });
    expect(await (await save({ in: "header", name: "Authorization", value: `Bearer ${short}` })).json()).toMatchObject({ hint: "" });
    const rows = await save({ preset: "twoHeaders", fields: { rows: [
      { in: "header", name: "apikey", value: KEY }, { in: "header", name: "Authorization", value: short, scheme: "Bearer" },
    ] } });
    expect(await rows.json()).toEqual({ parts: [{ in: "header", name: "apikey", hint: "WXYZ" }, { in: "header", name: "Authorization", hint: "" }] });
    // The end of a Basic value is the end of the base64 password.
    expect(await (await save({ preset: "basic", fields: { username: "admin", password: "s3cretpassword123" } })).json())
      .toEqual({ parts: [{ in: "header", name: "Authorization", hint: "" }] });
    expect(await (await save({ preset: "basic", fields: { username: KEY } })).json()).toMatchObject({ hint: "" });
  });

  it("saves Basic with a password when the public user name is in the examples, but not when the password is", async () => {
    const op = await seedOperation(api.id);
    const examples = (v: string) => getSql()`update operations set input_schema = ${getSql().json({ properties: { u: { type: "string", examples: [v] } } })} where id = ${op.id}`;
    const basic = { preset: "basic", fields: { username: "admin", password: "s3cretpassword123" } };
    await examples('{"username":"admin"}');
    expect((await save(basic)).status).toBe(200);
    await getSql()`update apis set upstream_auth = null where id = ${api.id}`;
    await examples("s3cretpassword123");
    expect((await save(basic)).status).toBe(400);
    await examples(Buffer.from("admin:s3cretpassword123").toString("base64"));
    expect((await save(basic)).status).toBe(400);
    expect(await storedRow()).toBeNull();
  });

  it("says why Basic with a password can't be saved with UPSTREAM_AUTH_V3 off", async () => {
    vi.stubEnv("UPSTREAM_AUTH_V3", "");
    const res = await save({ preset: "basic", fields: { username: "admin", password: "s3cretpassword123" } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/HTTP Basic with a password can't be saved/);
    expect(await storedRow()).toBeNull();
  });

  it("refuses a bag with UPSTREAM_AUTH_V3 off and stores nothing", async () => {
    vi.stubEnv("UPSTREAM_AUTH_V3", "");
    const res = await save(twoHeaders);
    expect(res.status).toBe(409);
    expect(await storedRow()).toBeNull();
    expect(checkKey).not.toHaveBeenCalled();
    // One value still saves.
    expect((await save({ preset: "bearer", fields: { key: KEY } })).status).toBe(200);
  });

  it("answers 400 with the preset's reason", async () => {
    const res = await save({ preset: "bearer", fields: { key: "abcd" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/too short/);
    expect((await save({ preset: "nope", fields: {} })).status).toBe(400);
    expect(await storedRow()).toBeNull();
  });

  it("saves fixed text that appears in the examples, but not a secret that does", async () => {
    const op = await seedOperation(api.id);
    await getSql()`update operations set input_schema = ${getSql().json({ properties: { v: { type: "string", examples: ["2022-06-28"] } } })} where id = ${op.id}`;
    expect((await save(keyPlusFixed)).status).toBe(200);

    await getSql()`update operations set input_schema = ${getSql().json({ properties: { v: { type: "string", examples: [KEY] } } })} where id = ${op.id}`;
    await getSql()`update apis set upstream_auth = null where id = ${api.id}`;
    const res = await save(keyPlusFixed);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/appears in your example requests/);
    expect(await storedRow()).toBeNull();
  });

  it("refuses a bag whose bare key, typed after a scheme word, is in the examples: the gateway's own leak set counts (audit 2)", async () => {
    const op = await seedOperation(api.id);
    await getSql()`update operations set input_schema = ${getSql().json({ properties: { k: { type: "string", examples: [KEY] } } })} where id = ${op.id}`;
    // The seller typed "Bearer <key>" into the value: the leak list holds the whole value, the gateway derives the key.
    const res = await save({
      preset: "twoHeaders",
      fields: { rows: [{ in: "header", name: "Authorization", value: `Bearer ${KEY}` }, { in: "header", name: "X-Client", value: "client_0123456789" }] },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/appears in your example requests/);
    expect(await storedRow()).toBeNull();
  });

  it("checks the sealed key before saving and refuses a key the API refused, on both the simple form and presets", async () => {
    const refused: KeyCheck = { opened: true, class: "refused", status: 401, op: "getPrice", reasons: ["The API refused its key (HTTP 401)."] };
    checkKey.mockResolvedValue(refused);
    for (const body of [{ in: "header", name: "X-API-Key", value: KEY }, twoHeaders]) {
      const res = await save(body);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "KEY_REFUSED", check: refused });
      expect(await storedRow()).toBeNull();
    }
    // What was checked is exactly what would be stored.
    const [, checked] = checkKey.mock.calls[1];
    expect(checked).toMatchObject({ v: 3 });

    checkKey.mockResolvedValue({ ...refused, class: "forbidden", status: 403 });
    expect((await save(twoHeaders)).status).toBe(409);

    const anyway = await save({ ...twoHeaders, saveAnyway: true });
    expect(anyway.status).toBe(200);
    expect(await anyway.json()).toMatchObject({ check: { class: "forbidden", status: 403 } });
    expect((await storedRow())?.sealed).toBe((checkKey.mock.calls.at(-1)![1] as StoredUpstreamAuth).sealed);
  });

  it("saves with the check in the answer when the API accepted the key or the check couldn't tell", async () => {
    checkKey.mockResolvedValue({ opened: true, class: "ok", status: 200, op: "getPrice" });
    const ok = await save({ in: "header", name: "X-API-Key", value: KEY });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ in: "header", name: "X-API-Key", hint: "WXYZ", check: { opened: true, class: "ok", status: 200, op: "getPrice" } });

    checkKey.mockResolvedValue({ opened: true, class: "unchecked", why: "not_proven" });
    expect((await save(twoHeaders)).status).toBe(200);
    checkKey.mockResolvedValue(null);
    const unchecked = await save({ in: "header", name: "X-API-Key", value: KEY });
    expect(await unchecked.json()).toEqual({ in: "header", name: "X-API-Key", hint: "WXYZ" });
  });

  it("answers 503 and stores nothing when the gateway can't open what the web sealed", async () => {
    checkKey.mockResolvedValue({ opened: false, class: "unchecked" });
    const res = await save({ in: "header", name: "X-API-Key", value: KEY, saveAnyway: true });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Adding a key isn't set up on Hirakumi right now. Try again later." });
    expect(await storedRow()).toBeNull();
  });

  it("warns about fixed text that looks like a key and a token about to expire, without stopping the save", async () => {
    const res = await save({
      preset: "keyPlusFixed",
      fields: { rows: [{ in: "header", name: "X-API-Key", value: KEY }, { in: "header", name: "X-App", value: "live_8aK2pQ7rT9vW1yZ3", fixed: true }] },
    });
    expect(res.status).toBe(200);
    const { warnings } = (await res.json()) as { warnings: string[] };
    expect(warnings).toEqual([expect.stringMatching(/fixed text in X-App looks like a key/)]);

    const soon = jwt(Math.floor(Date.now() / 1000) + 24 * 3600);
    const expiring = await save({ preset: "bearer", fields: { key: soon } });
    expect(expiring.status).toBe(200);
    expect(((await expiring.json()) as { warnings: string[] }).warnings).toEqual([expect.stringMatching(/token that expires on/)]);

    const later = await save({ preset: "bearer", fields: { key: jwt(Math.floor(Date.now() / 1000) + 30 * 24 * 3600) } });
    expect(await later.json()).not.toHaveProperty("warnings");
  });
});
