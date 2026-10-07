import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseStep } from "../src/onboarding/parseStep.js";
import type { SokosumiClient, SokosumiEvent } from "../src/sokosumi/client.js";
import { createInbox } from "../src/sokosumi/inbox.js";
import { SpecNotServedError } from "../src/openapi/fetchSpec.js";
import { createTestDb, seedOperation, type TestDb } from "./helpers/db.js";

let db: TestDb;
beforeAll(async () => (db = await createTestDb()));
afterAll(async () => db.close());

const WEB = "https://web.test";
const rand = () => Math.random().toString(36).slice(2, 10);
const past = "2020-01-01T00:00:00.000Z";
const future = () => new Date(Date.now() + 60_000).toISOString();
const SECRET = "a1b2c3d4e5f6g7h8i9j0";

type Task = { id: string; name: string; description: string | null; userId: string; organizationId: string | null; status: string };

function fakeSoko(task: Task) {
  let events: SokosumiEvent[] = [{ id: `evt_${rand()}`, taskId: task.id, createdAt: past, status: "READY", actor: { type: "user", id: task.userId } }];
  const soko = {
    me: vi.fn(),
    listEvents: vi.fn(async () => ({ events, nextCursor: null })),
    getTask: vi.fn(async () => task),
    createTaskEvent: vi.fn(),
    reportUsage: vi.fn(),
  } satisfies SokosumiClient;
  return { soko, setEvents: (e: SokosumiEvent[]) => (events = e) };
}

function newTask(description: string | null = null): Task {
  return { id: `tsk_${rand()}`, name: "Sell my API", description, userId: `user_${rand()}`, organizationId: null, status: "READY" };
}

async function linkSeller(sokosumiUserId: string): Promise<string> {
  const sellerId = `sel_${rand()}`;
  await db.pool.query(`insert into sellers (id, cardano_addr, sokosumi_user_id) values ($1, $2, $3)`, [sellerId, `addr_test1${rand()}`, sokosumiUserId]);
  return sellerId;
}

async function messagesForTask(taskId: string) {
  const { rows } = await db.pool.query<{ body: string; task_status: string | null; api_id: string | null }>(
    `select body, task_status, api_id from messages where task_id = $1 order by id`, [taskId]);
  return rows;
}

// A base URL is fetched once to check it isn't an OpenAPI file; here it answers 404.
const notFound = () => vi.fn().mockRejectedValue(new SpecNotServedError("Fetching your OpenAPI file returned HTTP 404. Check the link and try again.", 404));

async function run(task: Task, fetchSpec = notFound()) {
  const { soko, setEvents } = fakeSoko(task);
  const inbox = createInbox({ pool: db.pool, soko, webBaseUrl: WEB, fetchSpec });
  await inbox.poll();
  const reply = async (text: string) => {
    setEvents([{ id: `evt_${rand()}`, taskId: task.id, createdAt: future(), comment: text, actor: { type: "user", id: task.userId } }]);
    await inbox.poll();
  };
  return { reply, fetchSpec };
}

describe("a brief with a base URL and example requests (no OpenAPI file)", () => {
  it("first-time seller: lists the endpoints from the lines, asks for the one sign-in and keeps the intake for after it", async () => {
    const host = `${rand()}.example.dev`;
    const t = newTask(`My API: https://${host}/v1\n- GET /price?symbol=ADA\n- GET /coins/{id=cardano}?days?=7`);
    const { fetchSpec } = await run(t);
    expect(fetchSpec).toHaveBeenCalledWith(`https://${host}/v1`);
    const [m, link] = await messagesForTask(t.id);
    expect(m.task_status).toBe("RUNNING");
    expect(link.task_status).toBe("INPUT_REQUIRED");
    expect(m.body).toMatch(new RegExp(`^Step 1 of 7, Read your file: I read your example requests for https://${host}/v1 and found 2 endpoints:`));
    expect(m.body).toContain("1. GET /price (get_price): GET /price");
    expect(link.body).toMatch(/^Next: link your wallet\..*\nhttps:\/\/web\.test\/setup\?t=\S+&link=1\n/s);
    expect(m.body).not.toMatch(/[–—]/);
    expect((await db.pool.query(`select 1 from apis where sokosumi_task_id = $1`, [t.id])).rowCount).toBe(0);
    const { rows: [ct] } = await db.pool.query(`select pending_intake from coworker_tasks where task_id = $1`, [t.id]);
    expect(ct.pending_intake).toContain("GET /price?symbol=ADA");
  });

  it("linked seller: creates a samples API with no OpenAPI link, and parse reads it", async () => {
    const host = `${rand()}.example.dev`;
    const t = newTask(`https://${host}/v1/\nGET /price?symbol=ADA`);
    const sellerId = await linkSeller(t.userId);
    await run(t);
    const { rows: [api] } = await db.pool.query(
      `select id, seller_id, origin, openapi_url, intake_kind, samples, name from apis where sokosumi_task_id = $1`, [t.id]);
    expect(api).toMatchObject({
      seller_id: sellerId, origin: `https://${host}`, openapi_url: null, intake_kind: "samples",
      samples: { base: `https://${host}/v1`, lines: "GET /price?symbol=ADA" }, name: host,
    });
    expect((await messagesForTask(t.id))[0].body).toBe(`Step 1 of 7, Read your file: Got your example requests. Reading your example requests for https://${host}/v1 now.`);
    expect(await parseStep({ pool: db.pool, fetchSpec: vi.fn() }, api.id)).toBe("ran");
    expect((await db.pool.query(`select state, path_prefix from apis where id = $1`, [api.id])).rows[0]).toEqual({ state: "parsed", path_prefix: "/v1" });
  });

  it("explains a bad example line and asks again", async () => {
    const t = newTask("https://api.example.dev\nGET /price?symbol=");
    await run(t);
    expect((await messagesForTask(t.id))[0].body).toMatch(/Line 1: give an example value for "symbol".*Reply with your API's base URL and example requests/);
  });

  it("a base URL that times out still takes example requests", async () => {
    const t = newTask("https://api.example.dev/v1\nGET /price?symbol=ADA");
    await run(t, vi.fn().mockRejectedValue(new Error("upstream did not answer within 15000 ms")));
    expect((await messagesForTask(t.id))[0].body).toMatch(/I read your example requests for https:\/\/api.example.dev\/v1 and found 1 endpoints/);
  });

  it("an OpenAPI link with lines next to it is still an OpenAPI intake", async () => {
    const t = newTask("https://price.example.dev/openapi.json\nGET /price?symbol=ADA");
    const { fetchSpec } = await run(t, vi.fn().mockRejectedValue(new Error("offline")));
    expect(fetchSpec).toHaveBeenCalledWith("https://price.example.dev/openapi.json");
  });

  it.each([
    ["My spec: https://raw.githubusercontent.com/acme/api/main/spec\nEndpoints:\n- GET /pets\n- GET /pets/{petId}", "https://raw.githubusercontent.com/acme/api/main/spec"],
    ["https://gist.githubusercontent.com/u/abc/raw/petstore\n`/pets`", "https://gist.githubusercontent.com/u/abc/raw/petstore"],
    ["Spec: https://api.example.com/v1/spec\n/price is the main endpoint", "https://api.example.com/v1/spec"],
    ["OpenAPI here https://api.example.com/v1/petstore\nGET /pets", "https://api.example.com/v1/petstore"],
  ])("an OpenAPI link without .json or .yaml next to endpoint paths is still read as the OpenAPI file: %j", async (brief, link) => {
    const t = newTask(brief);
    const { fetchSpec } = await run(t, vi.fn().mockRejectedValue(new Error("offline")));
    expect(fetchSpec).toHaveBeenCalledWith(link);
    expect((await messagesForTask(t.id))[0].body).toContain(`I couldn't read ${link}: offline`);
  });

  it("crypto inputs named token or signature are example values, not keys", async () => {
    const t = newTask("https://api.example.dev\nGET /quote?token=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48\nGET /verify?signature=abcdef123456");
    await run(t);
    const [m] = await messagesForTask(t.id);
    expect(m.body).not.toMatch(/looks like it has a key/);
    expect(m.body).toMatch(/I read your example requests for https:\/\/api.example.dev and found 2 endpoints/);
  });

  it("a key parameter with a placeholder value is read, with a warning that says where the key goes", async () => {
    const t = newTask("https://api.example.dev\nGET /price?symbol=ADA&api_key=YOUR_KEY");
    await run(t);
    const [m] = await messagesForTask(t.id);
    expect(m.body).toMatch(/^Step 1 of 7, Read your file: Line 1: "api_key" may be your API's key\. .*ownership page/);
    expect(m.body).toMatch(/I read your example requests for https:\/\/api.example.dev and found 1 endpoints/);
  });

  it("the greeting without a link offers the no-OpenAPI route", async () => {
    const t = newTask("Please sell my API");
    await run(t);
    expect((await messagesForTask(t.id))[0].body).toContain("No OpenAPI file? Reply with your API's base URL and a few example requests, one per line, like GET /price?symbol=ADA.");
  });
});

describe("keys in comments", () => {
  it("a brief with a key is neither used nor repeated", async () => {
    const t = newTask(`https://api.example.dev/v1\nGET /price?symbol=ADA&api_key=${SECRET}`);
    await linkSeller(t.userId);
    await run(t);
    const [m] = await messagesForTask(t.id);
    expect(m.body).toMatch(/looks like it has a key, token or password in it, so I didn't use or save it/);
    expect(m.body).not.toContain(SECRET);
    expect((await db.pool.query(`select 1 from apis where sokosumi_task_id = $1`, [t.id])).rowCount).toBe(0);
  });

  it.each([
    ["described", false, null, "when you sign to prove you own it, after you choose endpoints"],
    ["endpoints_confirmed", false, null, "on the page where you sign to prove you own it"],
    ["ownership_verified", true, "[[act:key]]", "The test calls then run again"],
    ["ownership_verified", false, "[[act:key]]", "If the test calls need the key"],
    ["rule_built", false, "[[act:key]]", "Add your API's key here"],
    ["priced", false, "[[act:key]]", "Add your API's key here"],
    ["registering", false, "[[act:key]]", "Add your API's key here"],
    ["live", false, "[[act:key]]", "Add your API's key here"],
  ])("a reply with a key at %s (failed: %s) points at the one-time key link and does not act on it", async (state, failed, link, words) => {
    const t = newTask();
    const sellerId = await linkSeller(t.userId);
    const { reply } = await run(t);
    const apiId = `api_${rand()}`;
    await db.pool.query(
      `insert into apis (id, seller_id, name, origin, openapi_url, state, sokosumi_task_id, path_prefix) values ($1, $2, 'K', 'https://k.example.dev', 'https://k.example.dev/openapi.json', $4, $3, $5)`,
      [apiId, sellerId, t.id, state, `/${apiId}`]);
    if (failed) await db.pool.query(`insert into onboard_steps (api_id, step, status, attempts, output) values ($1, 'qa', 'failed', 1, '{"error":"refused (HTTP 401)"}'::jsonb)`, [apiId]);
    await reply(`here is my key X-API-Key: ${SECRET}`);
    const m = (await messagesForTask(t.id)).at(-1)!;
    expect(m.body).toContain(words);
    if (link) expect(m.body.endsWith(link)).toBe(true);
    else expect(m.body).not.toContain("[[act:");
    expect(m.body).not.toContain(WEB);
    expect(m.body).not.toContain(SECRET);
    expect(m.body).not.toMatch(/[–—]/);
  });

  it("a reply with a key before any API says where the key goes later, without a link", async () => {
    const t = newTask();
    const { reply } = await run(t);
    await reply(`here is my key X-API-Key: ${SECRET}`);
    const m = (await messagesForTask(t.id)).at(-1)!;
    expect(m.body).toContain("You'll add your API's key when you sign to prove you own it, after you choose endpoints.");
    expect(m.body).not.toContain(`${WEB}/apis/`);
  });
});

describe("the ownership step for an API without an OpenAPI file", () => {
  it("says to add the DNS TXT record, the same as for an OpenAPI link, and to add the key on the same page", async () => {
    const t = newTask();
    const sellerId = await linkSeller(t.userId);
    const { reply } = await run(t);
    const apiId = `api_${rand()}`;
    await db.pool.query(
      `insert into apis (id, seller_id, name, origin, openapi_url, state, sokosumi_task_id, path_prefix, intake_kind, samples)
       values ($1, $2, 'S', 'https://s.example.dev', null, 'described', $3, '/v1', 'samples', $4::jsonb)`,
      [apiId, sellerId, t.id, JSON.stringify({ base: "https://s.example.dev/v1", lines: "GET /price?symbol=ADA" })]);
    await db.pool.query(`insert into onboard_steps (api_id, step, status, attempts, output) values ($1, 'parse', 'done', 0, $2::jsonb)`,
      [apiId, JSON.stringify({ authHint: { in: "header", name: "Authorization", prefix: "Bearer " } })]);
    await seedOperation(db.pool, apiId, { opId: "get_price", method: "GET", path: "/price" });
    await reply("sell 1");
    const body = (await messagesForTask(t.id)).at(-1)?.body ?? "";
    const code: string = (await db.pool.query(`select token from challenges where api_id = $1 and kind = 'dns' and consumed_at is null`, [apiId])).rows[0].token;
    expect(body).toBe([
      "Step 4 of 7, Prove ownership: Prove you own s.example.dev: add this DNS TXT record where your domain's DNS is managed (your API itself doesn't change):",
      "- Type: `TXT`",
      "- Name: `_hirakumi.s` (the full name is `_hirakumi.s.example.dev`)",
      `- Value: \`${code}\``,
      "",
      "I look for it every 15 seconds and post here when I find it. Then you sign once with your Cardano wallet (no payment).",
      "Your API needs a key (a bearer token in the Authorization header): you add it on the page where you sign. Never paste it in a comment.",
    ].join("\n"));
    await reply("what now?");
    const help = (await messagesForTask(t.id)).at(-1)?.body ?? "";
    expect(help).toContain(`- Value: \`${code}\``);
    expect(help).toContain("Next: Prove you own s.example.dev: add this DNS TXT record");
    expect(help).not.toContain("hirakumi-verify.json");
  });
});

describe("test calls refused for a missing key", () => {
  it("a reply after QA failed at ownership_verified points at the one-time key link, not at starting over", async () => {
    const t = newTask();
    const sellerId = await linkSeller(t.userId);
    const { reply } = await run(t);
    const apiId = `api_${rand()}`;
    await db.pool.query(
      `insert into apis (id, seller_id, name, origin, openapi_url, state, sokosumi_task_id, path_prefix) values ($1, $2, 'Q', 'https://q.example.dev', 'https://q.example.dev/openapi.json', 'ownership_verified', $3, '/')`,
      [apiId, sellerId, t.id]);
    await db.pool.query(`insert into onboard_steps (api_id, step, status, attempts, output) values ($1, 'qa', 'failed', 1, '{"error":"refused (HTTP 401)"}'::jsonb)`, [apiId]);
    await reply("what now?");
    const m = (await messagesForTask(t.id)).at(-1)!;
    expect(m.body).toContain("If your API needs a key, add it here (sealed so only the Hirakumi gateway can read it) and the test calls run again: [[act:key]]");
    expect(m.body).not.toMatch(/^Onboarding stopped/);
    expect(m.body).not.toMatch(/[–—]/);
  });
});

describe("which link is the base URL", () => {
  async function linkedRun(brief: string) {
    const t = newTask(brief);
    await linkSeller(t.userId);
    await run(t);
    const { rows } = await db.pool.query<{ origin: string; samples: { base: string } }>(`select origin, samples from apis where sokosumi_task_id = $1`, [t.id]);
    return { t, rows };
  }

  it("takes the link labelled API, not the docs link before it", async () => {
    const { rows } = await linkedRun("Docs: https://docs.example.com/guide\nAPI: https://api.example.com/v1\nGET /price?symbol=ADA");
    expect(rows).toEqual([{ origin: "https://api.example.com", samples: expect.objectContaining({ base: "https://api.example.com/v1" }) }]);
  });

  it("asks which link is the base when two could be, and creates nothing", async () => {
    const { t, rows } = await linkedRun("Try https://one.example.com/v1 or https://two.example.com/v1\nGET /price?symbol=ADA");
    expect(rows).toEqual([]);
    const [m] = await messagesForTask(t.id);
    expect(m.body).toBe(
      "Step 1 of 7, Read your file: I found more than one link: https://one.example.com/v1 and https://two.example.com/v1. Which one is your API's base URL? " +
      "Reply with just that link, then your example requests, one per line.");
    expect(m.task_status).toBe("INPUT_REQUIRED");
  });
});

describe("a command reply with a link under it", () => {
  async function pricedTask() {
    const t = newTask();
    const sellerId = await linkSeller(t.userId);
    const { reply } = await run(t);
    const apiId = `api_${rand()}`;
    await db.pool.query(
      `insert into apis (id, seller_id, name, origin, openapi_url, state, sokosumi_task_id, path_prefix) values ($1, $2, 'P', 'https://p.example.dev', 'https://p.example.dev/openapi.json', 'rule_built', $3, $4)`,
      [apiId, sellerId, t.id, `/${apiId}`]);
    return { t, apiId, reply };
  }

  it("is the command once an API is under way, not a new samples intake", async () => {
    const { t, apiId, reply } = await pricedTask();
    const op = await seedOperation(db.pool, apiId, { opId: "get_price", method: "GET", path: "/price" });
    await db.pool.query(`update operations set enabled = true where id = $1`, [op]);
    await db.pool.query(`insert into rules (id, operation_id, version, definition, hash) values ($1, $2, 1, '{}'::jsonb, $3)`, [`rule_${rand()}`, op, rand()]);
    await reply("price 2\n/history needs ?days=7 though, see https://docs.example.com/guide");
    expect((await db.pool.query(`select id from apis where sokosumi_task_id = $1`, [t.id])).rows).toEqual([{ id: apiId }]);
    expect((await db.pool.query(`select state from apis where id = $1`, [apiId])).rows[0].state).toBe("priced");
    expect((await messagesForTask(t.id)).at(-1)?.body).toContain("Price saved: 2 tUSDM for 100 calls");
  });

  it("a reply of only a base URL and example requests is still read as samples (the task says it already has an API)", async () => {
    const { t, reply } = await pricedTask();
    await reply("https://other.example.com/v1\nGET /price?symbol=ADA");
    expect((await messagesForTask(t.id)).at(-1)?.body).toMatch(/This task already has P in progress/);
  });
});
