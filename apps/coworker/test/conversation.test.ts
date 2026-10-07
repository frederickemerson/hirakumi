import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { StructuredCall } from "../src/llm/claude.js";
import { describeStep } from "../src/onboarding/describeStep.js";
import { parseStep } from "../src/onboarding/parseStep.js";
import type { SokosumiClient, SokosumiEvent } from "../src/sokosumi/client.js";
import { createInbox } from "../src/sokosumi/inbox.js";
import { PRICE_SPEC } from "./fixtures.js";
import { createTestDb, seedOperation, type TestDb } from "./helpers/db.js";
import { inferRuleFromResponses, UpstreamTimeoutError, withRequiredPhrase } from "@hirakumi/core";
import { PermanentError } from "../src/errors.js";
import { SpecNotServedError } from "../src/openapi/fetchSpec.js";

let db: TestDb;
beforeAll(async () => (db = await createTestDb()));
afterAll(async () => db.close());

const WEB = "https://web.test";
const rand = () => Math.random().toString(36).slice(2, 10);
const past = "2020-01-01T00:00:00.000Z";
const future = () => new Date(Date.now() + 60_000).toISOString();

type Task = { id: string; name: string; description: string | null; userId: string; organizationId: string | null; status: string };

function fakeSoko(tasks: Record<string, Task>) {
  let events: SokosumiEvent[] = [];
  const soko = {
    me: vi.fn(),
    listEvents: vi.fn(async () => ({ events, nextCursor: null })),
    getTask: vi.fn(async (id: string) => tasks[id]),
    createTaskEvent: vi.fn(),
    reportUsage: vi.fn(),
  } satisfies SokosumiClient;
  return { soko, setEvents: (e: SokosumiEvent[]) => (events = e) };
}

async function messagesForTask(taskId: string) {
  const { rows } = await db.pool.query<{ body: string; task_status: string | null; api_id: string | null }>(
    `select body, task_status, api_id from messages where task_id = $1 order by id`, [taskId]);
  return rows;
}

async function newTask(o: { description?: string | null; user?: string } = {}) {
  const id = `tsk_${rand()}`;
  const user = o.user ?? `user_${rand()}`;
  const task: Task = { id, name: "Sell my API", description: o.description ?? null, userId: user, organizationId: null, status: "READY" };
  return { id, user, task };
}

async function linkSeller(sokosumiUserId: string): Promise<string> {
  const sellerId = `sel_${rand()}`;
  await db.pool.query(`insert into sellers (id, cardano_addr, sokosumi_user_id) values ($1, $2, $3)`, [sellerId, `addr_test1${rand()}`, sokosumiUserId]);
  return sellerId;
}

async function seedTaskApi(taskId: string, sellerId: string, state: string): Promise<string> {
  const apiId = `api_${rand()}`;
  await db.pool.query(
    `insert into apis (id, seller_id, name, origin, openapi_url, state, sokosumi_task_id, path_prefix) values ($1, $2, 'Price API', 'https://price.example.dev', 'https://price.example.dev/openapi.json', $3, $4, $5)`,
    [apiId, sellerId, state, taskId, `/${apiId}`]);
  return apiId;
}

const comment = (taskId: string, user: string, text: string, createdAt = future()): SokosumiEvent =>
  ({ id: `evt_${rand()}`, taskId, createdAt, comment: text, actor: { type: "user", id: user } });

describe("a new task whose brief holds the OpenAPI link", () => {
  it("first-time seller: reads the file (SSRF-safe fetcher), lists endpoints, suggests a price, asks for the one sign-in", async () => {
    const t = await newTask({ description: "Please put https://price.example.dev/openapi.json on sale." });
    const { soko, setEvents } = fakeSoko({ [t.id]: t.task });
    setEvents([{ id: `evt_${rand()}`, taskId: t.id, createdAt: past, status: "READY", actor: { type: "user", id: t.user } }]);
    const fetchSpec = vi.fn().mockResolvedValue(PRICE_SPEC);
    const inbox = createInbox({ pool: db.pool, soko, webBaseUrl: WEB, fetchSpec });
    expect(await inbox.poll()).toBe(1);
    expect(fetchSpec).toHaveBeenCalledWith("https://price.example.dev/openapi.json");
    const [m] = await messagesForTask(t.id);
    expect(m.task_status).toBe("INPUT_REQUIRED");
    expect(m.body).toMatch(/^Step 1 of 7, Read your file: I read Price API and found 3 endpoints \(I skipped 3\):/);
    expect(m.body).toContain("1. GET /price (getPrice): Current price for a symbol");
    expect(m.body).toContain("Suggested price: 2 tUSDM for 100 calls");
    const { rows: [ct] } = await db.pool.query(`select setup_token from coworker_tasks where task_id = $1`, [t.id]);
    expect(m.body).toContain(`${WEB}/setup?t=${ct.setup_token}`);
    expect((await db.pool.query(`select 1 from apis where sokosumi_task_id = $1`, [t.id])).rowCount).toBe(0);
  });

  it("a seller whose Sokosumi account is linked to a wallet starts onboarding at once", async () => {
    const t = await newTask({ description: "https://price.example.dev/openapi.json" });
    const sellerId = await linkSeller(t.user);
    const { soko, setEvents } = fakeSoko({ [t.id]: t.task });
    setEvents([{ id: `evt_${rand()}`, taskId: t.id, createdAt: past, status: "READY", actor: { type: "user", id: t.user } }]);
    const fetchSpec = vi.fn().mockResolvedValue(PRICE_SPEC);
    await createInbox({ pool: db.pool, soko, webBaseUrl: WEB, fetchSpec }).poll();
    // Fetched once to tell an OpenAPI file from a base URL; the parse step reads it again.
    expect(fetchSpec).toHaveBeenCalledWith("https://price.example.dev/openapi.json");
    const { rows: [api] } = await db.pool.query(`select id, seller_id, state, origin, openapi_url, name from apis where sokosumi_task_id = $1`, [t.id]);
    expect(api).toMatchObject({ seller_id: sellerId, state: "intake", origin: "https://price.example.dev", openapi_url: "https://price.example.dev/openapi.json", name: "price.example.dev" });
    expect(await messagesForTask(t.id)).toEqual([
      { body: "Step 1 of 7, Read your file: Got your link. Reading https://price.example.dev/openapi.json now.", task_status: "RUNNING", api_id: api.id },
    ]);
  });

  it("an unsafe link is refused with the web's wording, and nothing is fetched", async () => {
    const t = await newTask({ description: "http://price.example.dev/openapi.json" });
    const { soko, setEvents } = fakeSoko({ [t.id]: t.task });
    setEvents([{ id: `evt_${rand()}`, taskId: t.id, createdAt: past, actor: { type: "user", id: t.user } }]);
    const fetchSpec = vi.fn();
    await createInbox({ pool: db.pool, soko, webBaseUrl: WEB, fetchSpec }).poll();
    expect(fetchSpec).not.toHaveBeenCalled();
    expect((await messagesForTask(t.id))[0].body).toBe("Step 1 of 7, Read your file: The link must start with https:// Reply with the public https link to your OpenAPI file.");
  });

  it("a file that can't be fetched or read says why and asks for a corrected link", async () => {
    const t = await newTask({ description: "https://price.example.dev/openapi.json" });
    const { soko, setEvents } = fakeSoko({ [t.id]: t.task });
    setEvents([{ id: `evt_${rand()}`, taskId: t.id, createdAt: past, actor: { type: "user", id: t.user } }]);
    await createInbox({ pool: db.pool, soko, webBaseUrl: WEB, fetchSpec: vi.fn().mockResolvedValue('{"swagger":"2.0"}') }).poll();
    expect((await messagesForTask(t.id))[0].body).toMatch(/I couldn't read .*Swagger 2\.0.*Reply with the corrected link/);
  });
});

describe("a link is fetched to tell an OpenAPI file from a base URL", () => {
  async function brief(description: string, fetchSpec: (url: string) => Promise<string>, o: { linked?: boolean } = {}) {
    const t = await newTask({ description });
    if (o.linked) await linkSeller(t.user);
    const { soko, setEvents } = fakeSoko({ [t.id]: t.task });
    setEvents([{ id: `evt_${rand()}`, taskId: t.id, createdAt: past, actor: { type: "user", id: t.user } }]);
    await createInbox({ pool: db.pool, soko, webBaseUrl: WEB, fetchSpec }).poll();
    const { rows: apis } = await db.pool.query<{ openapi_url: string | null; intake_kind: string }>(
      `select openapi_url, intake_kind from apis where sokosumi_task_id = $1`, [t.id]);
    return { t, msgs: await messagesForTask(t.id), apis };
  }

  it.each([
    "https://api.example.com/api-json",
    "https://api.example.com/docs/json",
    "https://api.example.com/api/v1/oas",
    "https://api.example.com/v3/api-docs",
    "https://api.example.com/swagger/v1/swagger.json",
    "https://api.example.com/openapi",
    "https://api.example.com/spec",
  ])("%s served as a real spec is read as the OpenAPI file", async (link) => {
    const fetchSpec = vi.fn().mockResolvedValue(PRICE_SPEC);
    const { msgs, apis } = await brief(`Please sell ${link}`, fetchSpec);
    expect(fetchSpec).toHaveBeenCalledWith(link);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body).toMatch(/^Step 1 of 7, Read your file: I read Price API and found 3 endpoints/);
    expect(msgs[0].body).not.toMatch(/example requests/);
    expect(apis).toEqual([]);
  });

  it("a linked seller's /v3/api-docs spec starts an OpenAPI intake", async () => {
    const { msgs, apis } = await brief("https://api.example.com/v3/api-docs", vi.fn().mockResolvedValue(PRICE_SPEC), { linked: true });
    expect(apis).toEqual([{ openapi_url: "https://api.example.com/v3/api-docs", intake_kind: "openapi" }]);
    expect(msgs[0].body).toBe("Step 1 of 7, Read your file: Got your link. Reading https://api.example.com/v3/api-docs now.");
  });

  it("a Swagger 2.0 file is still told apart, with its own message", async () => {
    const { msgs } = await brief("https://api.example.com/v2/api-docs", vi.fn().mockResolvedValue('{"swagger":"2.0","paths":{}}'));
    expect(msgs[0].body).toMatch(/I couldn't read https:\/\/api\.example\.com\/v2\/api-docs: This is a Swagger 2\.0 file/);
  });

  it.each([
    ["an HTML page", vi.fn().mockResolvedValue("<!doctype html><html><body>Welcome</body></html>"), "it is a web page"],
    ["JSON that is not a spec", vi.fn().mockResolvedValue('{"status":"ok","version":"1.2"}'), "it is JSON with no openapi version"],
    ["a 404", vi.fn().mockRejectedValue(new SpecNotServedError("Fetching your OpenAPI file at x returned HTTP 404. Check the link and try again.", 404)), "it answered with HTTP 404"],
  ])("a base URL that serves %s gets the samples prompt", async (_, fetchSpec, reason) => {
    for (const linked of [false, true]) {
      const { msgs, apis } = await brief("https://api.example.com/v1", fetchSpec, { linked });
      expect(apis).toEqual([]);
      expect(msgs).toEqual([{
        body: `Step 1 of 7, Read your file: I opened https://api.example.com/v1, but it didn't look like an OpenAPI file (${reason}). ` +
          "If it's your API's base URL, reply with it and a few example requests, one per line, like this:\nhttps://api.example.com/v1\nGET /price?symbol=ADA\n" +
          "If it should be your OpenAPI file, check the link and send it again.",
        task_status: "INPUT_REQUIRED", api_id: null,
      }]);
      expect(msgs[0].body).not.toMatch(/[–—]/);
    }
  });

  it.each([
    ["a timeout", new UpstreamTimeoutError("upstream did not answer within 15000 ms"), "it didn't answer within 15 seconds."],
    ["a blocked address", new PermanentError("We can't fetch https://api.example.com/v1: it must be a public HTTPS address with no redirects (blocked address 10.0.0.1)."),
      "We can't fetch https://api.example.com/v1: it must be a public HTTPS address with no redirects (blocked address 10.0.0.1)."],
  ])("a fetch error (%s) gets a clear reply and starts nothing", async (_, err, problem) => {
    for (const linked of [false, true]) {
      const { msgs, apis } = await brief("https://api.example.com/v1", vi.fn().mockRejectedValue(err), { linked });
      expect(apis).toEqual([]);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toMatchObject({ task_status: "INPUT_REQUIRED" });
      expect(msgs[0].body).toBe(
        `Step 1 of 7, Read your file: I couldn't read https://api.example.com/v1: ${problem} Reply with the corrected link to try again. ` +
        "No OpenAPI file? Reply with your API's base URL and a few example requests, one per line, like GET /price?symbol=ADA.");
    }
  });

  it("a link and example lines, where the link is a spec, is read as the OpenAPI file and says the lines were ignored", async () => {
    const text = "https://api.example.com/v3/api-docs\nGET /price?symbol=ADA";
    const first = await brief(text, vi.fn().mockResolvedValue(PRICE_SPEC));
    expect(first.apis).toEqual([]);
    expect(first.msgs[0].body).toMatch(/^Step 1 of 7, Read your file: That link is an OpenAPI file, so I read it and ignored your example requests\. I read Price API and found 3 endpoints/);
    const linked = await brief(text, vi.fn().mockResolvedValue(PRICE_SPEC), { linked: true });
    expect(linked.apis).toEqual([{ openapi_url: "https://api.example.com/v3/api-docs", intake_kind: "openapi" }]);
    expect(linked.msgs[0].body).toBe(
      "Step 1 of 7, Read your file: That link is an OpenAPI file, so I read it and ignored your example requests. Got your link. Reading https://api.example.com/v3/api-docs now.");
  });

  it("fetches at most 3 links, likely OpenAPI files first", async () => {
    const fetchSpec = vi.fn().mockResolvedValue("<html></html>");
    await brief("https://a.example.com/x https://b.example.com/y https://c.example.com/z https://d.example.com/openapi.json", fetchSpec);
    expect(fetchSpec.mock.calls.map((c) => c[0])).toEqual(["https://d.example.com/openapi.json", "https://a.example.com/x", "https://b.example.com/y"]);
  });

  it("a reply with a link is fetched the same way", async () => {
    const t = await newTask();
    const { soko, setEvents } = fakeSoko({ [t.id]: t.task });
    setEvents([{ id: `evt_${rand()}`, taskId: t.id, createdAt: past, actor: { type: "user", id: t.user } }]);
    const fetchSpec = vi.fn().mockResolvedValue(PRICE_SPEC);
    const inbox = createInbox({ pool: db.pool, soko, webBaseUrl: WEB, fetchSpec });
    await inbox.poll();
    setEvents([comment(t.id, t.user, "here: https://api.example.com/docs/json")]);
    await inbox.poll();
    expect(fetchSpec).toHaveBeenCalledWith("https://api.example.com/docs/json");
    expect((await messagesForTask(t.id)).at(-1)?.body).toMatch(/I read Price API and found 3 endpoints/);
  });
});

describe("an OpenAPI file hosted somewhere else (GitHub)", () => {
  const GH = "https://raw.githubusercontent.com/acme/price/main/openapi.json";
  async function firstTime(spec: string) {
    const t = await newTask({ description: GH });
    const { soko, setEvents } = fakeSoko({ [t.id]: t.task });
    setEvents([{ id: `evt_${rand()}`, taskId: t.id, createdAt: past, actor: { type: "user", id: t.user } }]);
    await createInbox({ pool: db.pool, soko, webBaseUrl: WEB, fetchSpec: vi.fn().mockResolvedValue(spec) }).poll();
    return (await messagesForTask(t.id))[0].body;
  }
  it("is read when servers[0] is the API's full base URL", async () => {
    const body = await firstTime(JSON.stringify({ ...JSON.parse(PRICE_SPEC), servers: [{ url: "https://api.acme.dev/v1" }] }));
    expect(body).toMatch(/I read Price API and found 3 endpoints/);
  });
  it("without a full servers URL, says so before the sign-in", async () => {
    const body = await firstTime(PRICE_SPEC);
    expect(body).toMatch(/I couldn't read .*raw\.githubusercontent\.com, which can't be where your API runs\. Set the first servers URL/);
    expect(body).not.toContain("/setup?t=");
  });
});

describe("replies on a task", () => {
  async function setup(state: string, o: { llm?: StructuredCall } = {}) {
    const t = await newTask();
    const sellerId = await linkSeller(t.user);
    const { soko, setEvents } = fakeSoko({ [t.id]: t.task });
    setEvents([{ id: `evt_${rand()}`, taskId: t.id, createdAt: past, status: "READY", actor: { type: "user", id: t.user } }]);
    const inbox = createInbox({ pool: db.pool, soko, webBaseUrl: WEB, fetchSpec: vi.fn(), llm: o.llm ?? null });
    await inbox.poll(); // takes the task (no link: setup message)
    const apiId = await seedTaskApi(t.id, sellerId, state);
    const get = await seedOperation(db.pool, apiId, { opId: "getPrice", method: "GET", path: "/price" });
    const post = await seedOperation(db.pool, apiId, { opId: "createAlert", method: "POST", path: "/alerts" });
    const reply = async (text: string, user = t.user) => {
      const e = comment(t.id, user, text);
      setEvents([e]);
      await inbox.poll();
      return e;
    };
    return { t, apiId, get, post, reply, setEvents, inbox, soko };
  }

  it("`sell 2` chooses endpoints, then posts the one wallet deep link for ownership", async () => {
    const { t, apiId, reply } = await setup("described");
    await reply("sell 2");
    const { rows: ops } = await db.pool.query(`select op_id, enabled, side_effects_confirmed_none from operations where api_id = $1 order by op_id`, [apiId]);
    expect(ops).toEqual([
      { op_id: "createAlert", enabled: false, side_effects_confirmed_none: false },
      { op_id: "getPrice", enabled: true, side_effects_confirmed_none: true },
    ]);
    expect((await db.pool.query(`select state, escrow_op_id from apis where id = $1`, [apiId])).rows[0]).toEqual({ state: "endpoints_confirmed", escrow_op_id: "getPrice" });
    const msgs = (await messagesForTask(t.id)).slice(1);
    expect(msgs).toEqual([
      { body: "Step 3 of 7, Choose endpoints: Selling GET /price. Per-job hires (Masumi escrow) run getPrice.", task_status: "RUNNING", api_id: apiId },
      { body: `Step 4 of 7, Prove ownership: Prove you own https://price.example.dev/${apiId}: make your API send the header X-Hirakumi-Verify with the code from this page on responses at your base URL (any status counts, even a 404 page), then sign once with your Cardano wallet (no payment): ${WEB}/apis/${apiId}/ownership`, task_status: "INPUT_REQUIRED", api_id: apiId },
    ]);
  });

  it("an endpoint that may change data needs `readonly` typed by the seller", async () => {
    const { t, apiId, reply } = await setup("described");
    await reply("sell 1"); // /alerts sorts first
    expect((await db.pool.query(`select state from apis where id = $1`, [apiId])).rows[0].state).toBe("described");
    expect((await messagesForTask(t.id)).at(-1)?.body).toMatch(/POST \/alerts may change data\. .*`sell 1 readonly`/);
    await reply("sell 1 readonly");
    expect((await db.pool.query(`select state, escrow_op_id from apis where id = $1`, [apiId])).rows[0]).toEqual({ state: "endpoints_confirmed", escrow_op_id: "createAlert" });
  });

  it("acts once per comment, only for the task owner, and never on comments older than the task", async () => {
    const { t, apiId, setEvents, inbox } = await setup("described");
    const stranger = comment(t.id, "someone_else", "sell 2");
    const old = comment(t.id, t.user, "sell 2", past);
    setEvents([stranger, old]);
    await inbox.poll();
    expect((await db.pool.query(`select state from apis where id = $1`, [apiId])).rows[0].state).toBe("described");
    const mine = comment(t.id, t.user, "sell 2");
    setEvents([mine]);
    await inbox.poll();
    await inbox.poll();
    expect((await messagesForTask(t.id)).filter((m) => m.body.includes("Choose endpoints"))).toHaveLength(1);
  });

  it("`price 2.5 for 200 calls` saves the pack before publishing; publishing itself needs the wallet", async () => {
    const { t, apiId, get, reply } = await setup("rule_built");
    await db.pool.query(`update operations set enabled = (id = $1) where api_id = $2`, [get, apiId]);
    await db.pool.query(`insert into rules (id, operation_id, version, definition, hash) values ($1, $2, 1, '{}'::jsonb, 'sha256:x')`, [`rule_${rand()}`, get]);
    await reply("price 0.5");
    expect((await messagesForTask(t.id)).at(-1)?.body).toMatch(/at least 1 tUSDM/);
    // Escrow packs pay per call, so the price must split evenly across the calls.
    await reply("price 1.000001 for 3 calls");
    expect((await messagesForTask(t.id)).at(-1)?.body).toMatch(/split evenly across its 3 calls.*Try a round price such as 1\.000002 tUSDM/);
    await reply("price 2.5 for 200 calls");
    expect((await db.pool.query(`select calls, price_micros::text, escrow_price_micros::text from packs where api_id = $1`, [apiId])).rows)
      .toEqual([{ calls: 200, price_micros: "2500000", escrow_price_micros: "2000000" }]);
    expect((await db.pool.query(`select state from apis where id = $1`, [apiId])).rows[0].state).toBe("priced");
    expect((await messagesForTask(t.id)).at(-1)).toEqual({
      body: `Step 6 of 7, Write the promise: Price saved: 2.5 tUSDM for 200 calls, and 2 tUSDM per escrow job. Publishing needs your wallet signature: approve it here (one signature): ${WEB}/apis/${apiId}/review`,
      task_status: "INPUT_REQUIRED", api_id: apiId,
    });
    await reply("publish");
    expect((await db.pool.query(`select state from apis where id = $1`, [apiId])).rows[0].state).toBe("priced");
    expect((await messagesForTask(t.id)).at(-1)?.body).toBe(
      `Step 7 of 7, Register on Masumi: Publishing needs your wallet signature, so I can't do it from a comment. Approve it here (one signature): ${WEB}/apis/${apiId}/review`);
  });

  it("`price` on a status-only text promise reminds the seller to set the phrase before publishing", async () => {
    const { t, apiId, get, reply } = await setup("rule_built");
    await db.pool.query(`update operations set enabled = (id = $1) where api_id = $2`, [get, apiId]);
    const statusOnly = inferRuleFromResponses([{ status: 200, contentType: "text/plain", body: "1.5", latencyMs: 1 }]);
    await db.pool.query(`insert into rules (id, operation_id, version, definition, hash) values ($1, $2, 1, $3::jsonb, 'sha256:x')`, [`rule_${rand()}`, get, JSON.stringify(statusOnly)]);
    await reply("price 2");
    expect((await messagesForTask(t.id)).at(-1)?.body).toMatch(/approve it here \(one signature\): \S+\/review Before publishing, set the phrase every good answer must contain on the same page\.$/);
    const phrased = withRequiredPhrase(statusOnly, "price");
    await db.pool.query(`insert into rules (id, operation_id, version, definition, hash) values ($1, $2, 2, $3::jsonb, 'sha256:y')`, [`rule_${rand()}`, get, JSON.stringify(phrased)]);
    await reply("price 3");
    expect((await messagesForTask(t.id)).at(-1)?.body).toMatch(/approve it here \(one signature\): \S+\/review$/);
  });

  it("`price` before the test calls are done is refused", async () => {
    const { t, reply } = await setup("described");
    await reply("price 2");
    expect((await messagesForTask(t.id)).at(-1)?.body).toMatch(/after the test calls and before publishing/);
  });

  it("free text goes through the LLM only to pick an offered choice, then the same validation", async () => {
    const llm = vi.fn().mockResolvedValue({ choice: "sell", endpoints: ["2"], price_tusdm: null, calls: null }) as unknown as StructuredCall;
    const { t, apiId, reply } = await setup("described", { llm });
    await reply("let's go with the price endpoint");
    expect((await db.pool.query(`select state from apis where id = $1`, [apiId])).rows[0].state).toBe("endpoints_confirmed");
    expect((await messagesForTask(t.id)).find((m) => m.body.includes("Choose endpoints"))?.body).toMatch(/I read your reply as `sell 2`\. Selling GET \/price/);
  });

  it("without a command (and no LLM) it says what it needs at this step", async () => {
    const { t, apiId, reply } = await setup("ownership_verified");
    await reply("how is it going?");
    expect((await messagesForTask(t.id)).at(-1)).toMatchObject({ body: "Test calls are running. I'll post the promise and a suggested price here when they're done.", api_id: apiId });
  });

  it("at the ownership step it says to send the X-Hirakumi-Verify header at the base URL, never to host a file", async () => {
    const { t, apiId, reply } = await setup("endpoints_confirmed");
    await reply("what now?");
    const body = (await messagesForTask(t.id)).at(-1)?.body ?? "";
    expect(body).toContain(`Next, prove you own https://price.example.dev/${apiId}: make your API send the header X-Hirakumi-Verify with the code from this page`);
    expect(body).toContain("any status counts, even a 404 page), then sign once with your Cardano wallet");
    expect(body).not.toMatch(/x-hirakumi-verify line|hirakumi-verify\.json|OpenAPI file/);
    expect(body).toContain(`${WEB}/apis/${apiId}/ownership`);
    expect(body).not.toMatch(/well-known|challenge|download|upload/i);
    expect(body).not.toMatch(/[–—]/);
  });

  it("a second link on a task that already has an API is not a second API", async () => {
    const { t, reply } = await setup("described");
    await reply("https://other.example.dev/openapi.json");
    expect((await db.pool.query(`select count(*)::int as n from apis where sokosumi_task_id = $1`, [t.id])).rows[0].n).toBe(1);
    expect((await messagesForTask(t.id)).at(-1)?.body).toMatch(/already has Price API in progress/);
  });
});

describe("describeStep on a Sokosumi task", () => {
  it("posts a numbered list the seller can answer with `sell`", async () => {
    const t = await newTask();
    const sellerId = await linkSeller(t.user);
    await db.pool.query(`insert into coworker_tasks (task_id, sokosumi_user_id, task_name, setup_token) values ($1, $2, 'x', $3)`, [t.id, t.user, rand()]);
    const apiId = await seedTaskApi(t.id, sellerId, "intake");
    // Its own folder: other tests in this file list APIs on the same host (one API, one listing).
    const spec = JSON.stringify({ ...JSON.parse(PRICE_SPEC), servers: [{ url: `https://price.example.dev/${apiId}` }] });
    await parseStep({ pool: db.pool, fetchSpec: vi.fn().mockResolvedValue(spec) }, apiId);
    const llm = vi.fn().mockResolvedValue({ operations: [
      { opId: "getPrice", description: "Latest price for a ticker.", sideEffectsLikely: false },
      { opId: "get_history_symbol", description: "Daily price history.", sideEffectsLikely: false },
      { opId: "createAlert", description: "Creates an alert.", sideEffectsLikely: false },
    ] }) as unknown as StructuredCall;
    await describeStep({ pool: db.pool, llm, webBaseUrl: WEB }, apiId);
    const msgs = await messagesForTask(t.id);
    expect(msgs[0].body).toMatch(/^Step 1 of 7, Read your file: I read your OpenAPI file and found 3 endpoints/);
    expect(msgs[1].body).toBe([
      "Step 2 of 7, Describe endpoints: Found 3 endpoints; 2 look sellable (read-only):",
      "1. POST /alerts (createAlert): Creates an alert. [may change data]",
      "2. GET /history/{symbol} (get_history_symbol): Daily price history.",
      "3. GET /price (getPrice): Latest price for a ticker.",
      "Next, choose the endpoints to sell: reply `sell 1` with their numbers (for example `sell 1 2`). Endpoints marked [may change data] also need `readonly` at the end, to confirm they change nothing on your server. " +
        `You can also choose on the web: ${WEB}/apis/${apiId}`,
    ].join("\n"));
  });
});
