import { hashActToken, RuleInferenceError } from "@hirakumi/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChallengeCheck, DnsGateway, GatewayClient, PreviewResult } from "../src/gateway.js";
import type { LeakCheck } from "../src/leakCheck.js";
import type { StructuredCall } from "../src/llm/claude.js";
import { dnsCheckIntervalMs, watchDnsOnce } from "../src/onboarding/dnsWatch.js";
import { qaStep } from "../src/onboarding/qaStep.js";
import { INVALID_STRING } from "../src/qa/inputs.js";
import type { SokosumiClient, SokosumiEvent } from "../src/sokosumi/client.js";
import { createInbox } from "../src/sokosumi/inbox.js";
import { deliverMessages } from "../src/sokosumi/outbox.js";
import { addPhrase } from "../src/sokosumi/sellerActions.js";
import { PRICE_SPEC } from "./fixtures.js";
import { createTestDb, seedApi, seedOperation, type TestDb } from "./helpers/db.js";

/**
 * The seller never needs the Hirakumi website: every step is a comment on the Sokosumi task, except the wallet
 * signatures, which are one-time /act links.
 */
let db: TestDb;
beforeAll(async () => (db = await createTestDb()));
afterAll(async () => db.close());

const WEB = "https://web.test";
const rand = () => Math.random().toString(36).slice(2, 10);
const past = "2020-01-01T00:00:00.000Z";
const future = () => new Date(Date.now() + 60_000).toISOString();
const MISSING: ChallengeCheck = { ok: false, reason: "missing", record: "_hirakumi.price.example.dev", detail: "no record" };
const FOUND: ChallengeCheck = { ok: true, reason: "verified", record: "_hirakumi.price.example.dev", detail: "found" };

const dnsGateway = (answer: () => ChallengeCheck) => ({ checkChallenge: vi.fn(async () => answer()) }) satisfies DnsGateway;

async function taskApi(state: string) {
  const taskId = `tsk_${rand()}`;
  const apiId = await seedApi(db.pool, { state, sokosumiTaskId: taskId });
  const opId = await seedOperation(db.pool, apiId);
  return { taskId, apiId, opId };
}

async function addCode(apiId: string, proof: Record<string, unknown> | null = null): Promise<string> {
  const id = `ch_${rand()}`;
  await db.pool.query(`insert into challenges (id, api_id, kind, token, expires_at, proof) values ($1, $2, 'dns', $3, now() + interval '10 years', $4::jsonb)`,
    [id, apiId, `hkv_${rand()}`, proof ? JSON.stringify(proof) : null]);
  return id;
}

const bodies = async (apiId: string) =>
  (await db.pool.query<{ body: string }>(`select body from messages where api_id = $1 order by id`, [apiId])).rows.map((r) => r.body);

describe("the coworker finds the DNS record itself", () => {
  it("looks the record up, waits quietly while it is missing, and on a pass records it like the web and posts the signing link once", async () => {
    const { apiId } = await taskApi("endpoints_confirmed");
    const ch = await addCode(apiId);
    let answer = MISSING;
    const gateway = dnsGateway(() => answer);
    const t0 = new Date();
    expect(await watchDnsOnce({ pool: db.pool, gateway, now: () => t0 })).toBe(0);
    expect(gateway.checkChallenge).toHaveBeenCalledWith(apiId);
    expect(await bodies(apiId)).toEqual([]);
    // Within the interval: not looked up again.
    await watchDnsOnce({ pool: db.pool, gateway, now: () => new Date(t0.getTime() + 5_000) });
    expect(gateway.checkChallenge).toHaveBeenCalledTimes(1);
    answer = FOUND;
    const t1 = new Date(t0.getTime() + 16_000);
    expect(await watchDnsOnce({ pool: db.pool, gateway, now: () => t1 })).toBe(1);
    const { rows: [c] } = await db.pool.query(`select proof->>'passedAt' as passed, proof->>'record' as record from challenges where id = $1`, [ch]);
    expect(c).toEqual({ passed: t1.toISOString(), record: FOUND.record });
    expect(await bodies(apiId)).toEqual([
      "Step 4 of 7, Prove ownership: Found your record at `_hirakumi.price.example.dev`. Keep it in place while your API is listed. " +
        "Now sign once with your Cardano wallet to prove you own price.example.dev (no payment): [[act:ownership]]",
    ]);
    // A fresh pass is not looked up again; a stale one is, quietly (the same comment is never posted twice).
    await watchDnsOnce({ pool: db.pool, gateway, now: () => new Date(t1.getTime() + 60_000) });
    expect(gateway.checkChallenge).toHaveBeenCalledTimes(2);
    await db.pool.query(`update challenges set proof = proof || jsonb_build_object('passedAt', (now() - interval '31 minutes')::text) where id = $1`, [ch]);
    await watchDnsOnce({ pool: db.pool, gateway, now: () => new Date(t1.getTime() + 120_000) });
    expect(gateway.checkChallenge).toHaveBeenCalledTimes(3);
    expect(await bodies(apiId)).toHaveLength(1);
  });

  it("says once when the record holds another code, and asks for the key on the signing page when the API needs one", async () => {
    const { apiId } = await taskApi("endpoints_confirmed");
    await addCode(apiId);
    await db.pool.query(`insert into onboard_steps (api_id, step, status, attempts, output) values ($1, 'parse', 'done', 0, $2::jsonb)`,
      [apiId, JSON.stringify({ authHint: { in: "header", name: "X-API-Key" } })]);
    let answer: ChallengeCheck = { ...MISSING, reason: "mismatch" };
    const gateway = dnsGateway(() => answer);
    const t0 = Date.now();
    await watchDnsOnce({ pool: db.pool, gateway, now: () => new Date(t0) });
    await watchDnsOnce({ pool: db.pool, gateway, now: () => new Date(t0 + 20_000) });
    expect(await bodies(apiId)).toEqual([expect.stringMatching(/There is a TXT record at `_hirakumi\.price\.example\.dev`, but not with this API's code\./)]);
    answer = FOUND;
    await watchDnsOnce({ pool: db.pool, gateway, now: () => new Date(t0 + 40_000) });
    expect((await bodies(apiId)).at(-1)).toContain("and add your API's key there (sealed so only the Hirakumi gateway can read it): [[act:ownership]]");
  });

  it("leaves APIs without a Sokosumi task (the ownership page checks those), other states and replaced APIs alone", async () => {
    const dash = await seedApi(db.pool, { state: "endpoints_confirmed" });
    await addCode(dash);
    const { apiId: early } = await taskApi("described");
    await addCode(early);
    const { taskId, apiId: old } = await taskApi("endpoints_confirmed");
    await addCode(old);
    await new Promise((r) => setTimeout(r, 5));
    const newer = await seedApi(db.pool, { state: "described", sokosumiTaskId: taskId });
    const gateway = dnsGateway(() => FOUND);
    await watchDnsOnce({ pool: db.pool, gateway });
    for (const id of [dash, early, old, newer]) expect(gateway.checkChallenge).not.toHaveBeenCalledWith(id);
  });

  it("looks often at first, then less, and stops after two weeks", () => {
    expect(dnsCheckIntervalMs(0)).toBe(15_000);
    expect(dnsCheckIntervalMs(2 * 3600_000)).toBe(120_000);
    expect(dnsCheckIntervalMs(3 * 86400_000)).toBe(600_000);
    expect(dnsCheckIntervalMs(15 * 86400_000)).toBeNull();
  });
});

describe("`phrase` replies (the text promise's phrase, without the review page)", () => {
  const textRule = (body = "Price of ADA: 0.31") => ({ status: 200, contentType: "text/plain", body, latencyMs: 1 });
  async function statusOnlyApi(state = "rule_built", ops = ["getPrice"]) {
    const { inferRuleFromResponses } = await import("@hirakumi/core");
    const { apiId } = await taskApi(state);
    await db.pool.query(`delete from operations where api_id = $1`, [apiId]);
    const ids: string[] = [];
    for (const [i, opId] of ops.entries()) {
      const id = await seedOperation(db.pool, apiId, { opId, path: `/p${i}` });
      ids.push(id);
      await db.pool.query(`insert into rules (id, operation_id, version, definition, hash, plain_english) values ($1, $2, 1, $3::jsonb, 'sha256:x', 'Good. This is a status-only promise: it does not check the content.')`,
        [`rule_${rand()}`, id, JSON.stringify(inferRuleFromResponses([textRule()]))]);
    }
    await db.pool.query(`insert into onboard_steps (api_id, step, status, attempts, output) values ($1, 'qa', 'done', 0, $2::jsonb)`,
      [apiId, JSON.stringify({ goodAnswers: Object.fromEntries(ops.map((o) => [o, [{ body: "Price of ADA: 0.31", complete: true }]])) })]);
    return { apiId, ids };
  }

  it("adds the phrase as a new promise version, with the web's rules", async () => {
    const { apiId, ids } = await statusOnlyApi();
    const r = await addPhrase(db.pool, apiId, '"Price of"');
    expect(r).toEqual({ ok: true, message: 'Saved. Every good answer from GET /p0 must contain "Price of". The promise now reads: Good. Every good answer contains "Price of".' });
    const { rows } = await db.pool.query(`select version, plain_english from rules where operation_id = $1 order by version`, [ids[0]]);
    expect(rows.map((x) => x.version)).toEqual([1, 2]);
    // Stored as a JSON object (what the gateway reads), not a JSON string.
    const { rows: [def] } = await db.pool.query(`select jsonb_typeof(definition) as t, definition->>'contentType' as ct from rules where operation_id = $1 and version = 2`, [ids[0]]);
    expect(def).toEqual({ t: "object", ct: "text/plain" });
    // A phrase one of the seller's own good answers lacks would refuse them.
    expect(await addPhrase(db.pool, apiId, "Bitcoin")).toEqual({ ok: false, error: expect.stringMatching(/^Not every good answer from your test calls contains "Bitcoin"/) });
    void RuleInferenceError;
  });

  it("names the endpoint when several need a phrase, and refuses once the listing is published", async () => {
    const { apiId } = await statusOnlyApi("rule_built", ["getPrice", "getQuote"]);
    expect(await addPhrase(db.pool, apiId, "Price")).toEqual({ ok: false, error: "Name the endpoint first, like `phrase 1 Price`. Endpoints: 1 (GET /p0), 2 (GET /p1)." });
    expect(await addPhrase(db.pool, apiId, "2 Price")).toMatchObject({ ok: true, message: expect.stringContaining("GET /p1") });
    expect(await addPhrase(db.pool, apiId, "getPrice Price")).toMatchObject({ ok: true, message: expect.stringContaining("GET /p0") });
    await db.pool.query(`update apis set state = 'registering' where id = $1`, [apiId]);
    expect(await addPhrase(db.pool, apiId, "1 Price")).toEqual({ ok: false, error: "Your promise is published, so it can't change any more." });
  });
});

type Task = { id: string; name: string; description: string | null; userId: string; organizationId: string | null; status: string };
function fakeSoko(tasks: Record<string, Task>) {
  let events: SokosumiEvent[] = [];
  const soko = {
    me: vi.fn(),
    listEvents: vi.fn(async () => ({ events, nextCursor: null })),
    getTask: vi.fn(async (id: string) => tasks[id]),
    createTaskEvent: vi.fn(async () => ({ id: "evt" })),
    reportUsage: vi.fn(),
  } satisfies SokosumiClient;
  return { soko, setEvents: (e: SokosumiEvent[]) => (events = e) };
}
const comment = (taskId: string, user: string, text: string): SokosumiEvent =>
  ({ id: `evt_${rand()}`, taskId, createdAt: future(), comment: text, actor: { type: "user", id: user } });

describe("a first-time seller links the wallet once, then onboarding starts from what they already sent", () => {
  it("keeps the intake while they sign on the setup link, and starts it as soon as the account is linked", async () => {
    const user = `user_${rand()}`;
    const task: Task = { id: `tsk_${rand()}`, name: "Sell my API", description: "https://price.example.dev/openapi.json", userId: user, organizationId: null, status: "READY" };
    const { soko, setEvents } = fakeSoko({ [task.id]: task });
    setEvents([{ id: `evt_${rand()}`, taskId: task.id, createdAt: past, status: "READY", actor: { type: "user", id: user } }]);
    const fetchSpec = vi.fn().mockResolvedValue(PRICE_SPEC);
    const inbox = createInbox({ pool: db.pool, soko, webBaseUrl: WEB, fetchSpec });
    await inbox.poll();
    const first = (await db.pool.query(`select body from messages where task_id = $1 order by id`, [task.id])).rows;
    expect(first.at(-1).body).toMatch(/^Next: link your wallet\..*\/setup\?t=\S+&link=1/s);
    expect((await db.pool.query(`select 1 from apis where sokosumi_task_id = $1`, [task.id])).rowCount).toBe(0);
    setEvents([]);
    await inbox.poll(); // not linked yet: nothing happens
    expect((await db.pool.query(`select 1 from apis where sokosumi_task_id = $1`, [task.id])).rowCount).toBe(0);
    // The setup link (apps/web /api/sokosumi/link) links the account to the wallet.
    await db.pool.query(`insert into sellers (id, cardano_addr, sokosumi_user_id) values ($1, $2, $3)`, [`sel_${rand()}`, `addr_test1${rand()}`, user]);
    await inbox.poll();
    await inbox.poll();
    expect((await db.pool.query(`select state from apis where sokosumi_task_id = $1`, [task.id])).rows).toEqual([{ state: "intake" }]);
    const msgs = (await db.pool.query(`select body from messages where task_id = $1 order by id`, [task.id])).rows.map((r) => r.body);
    expect(msgs.at(-1)).toBe("Step 1 of 7, Read your file: Got your link. Reading https://price.example.dev/openapi.json now.");
    expect((await db.pool.query(`select pending_intake from coworker_tasks where task_id = $1`, [task.id])).rows[0].pending_intake).toBeNull();
  });
});

describe("end to end in Sokosumi: DNS found, sign link, test calls, price, publish link", () => {
  it("never links the seller to the website: only one-time /act links naming the owner's wallet", async () => {
    const user = `user_${rand()}`;
    const taskId = `tsk_${rand()}`;
    const sellerId = `sel_${rand()}`;
    const addr = `addr_test1${rand()}${rand()}`;
    await db.pool.query(`insert into sellers (id, cardano_addr, sokosumi_user_id) values ($1, $2, $3)`, [sellerId, addr, user]);
    const apiId = await seedApi(db.pool, { state: "described", sokosumiTaskId: taskId, sellerId });
    await seedOperation(db.pool, apiId);
    const task: Task = { id: taskId, name: "Sell", description: null, userId: user, organizationId: null, status: "READY" };
    const { soko, setEvents } = fakeSoko({ [taskId]: task });
    setEvents([{ id: `evt_${rand()}`, taskId, createdAt: past, status: "READY", actor: { type: "user", id: user } }]);
    const leakCheck = vi.fn<LeakCheck>().mockResolvedValue({ exposure: "protected", endpoints: [] });
    const inbox = createInbox({ pool: db.pool, soko, webBaseUrl: WEB, fetchSpec: vi.fn(), leakCheck });
    await inbox.poll();
    const reply = async (text: string) => {
      setEvents([comment(taskId, user, text)]);
      await inbox.poll();
    };
    const posted: string[] = [];
    const deliver = async () => {
      soko.createTaskEvent.mockClear();
      await deliverMessages(db.pool, soko, WEB);
      const calls = soko.createTaskEvent.mock.calls as unknown as [string, { comment: string }][];
      posted.push(...calls.filter((c) => c[0] === taskId).map((c) => c[1].comment));
      return posted.at(-1)!;
    };

    // Choose endpoints, then the DNS record (no link).
    await reply("sell 1");
    expect(await deliver()).toMatch(/Prove you own price\.example\.dev: add this DNS TXT record.*I look for it every 15 seconds/s);

    // The coworker finds the record and posts the one-time ownership link.
    await watchDnsOnce({ pool: db.pool, gateway: dnsGateway(() => FOUND) });
    const found = await deliver();
    const token = /\/act\/([A-Za-z0-9_-]{43})/.exec(found)![1];
    expect(found).toContain(`Sign with the wallet ending \`…${addr.slice(-6)}\`.`);
    const { rows: [act] } = await db.pool.query(`select api_id, action, wallet from act_tokens where token_hash = $1`, [hashActToken(token)]);
    expect(act).toEqual({ api_id: apiId, action: "ownership", wallet: addr });

    // The seller signs on /act (apps/web finalizeOwnership), and the coworker runs the test calls.
    await db.pool.query(`update apis set state = 'ownership_verified' where id = $1`, [apiId]);
    await db.pool.query(`update act_tokens set used_at = now() where token_hash = $1`, [hashActToken(token)]);
    const json = (status: number, body: unknown): PreviewResult => ({ status, contentType: "application/json", body: JSON.stringify(body), latencyMs: 5 });
    const gateway = { preview: vi.fn(async (_a: string, _o: string, i: Record<string, unknown>) =>
      i.symbol === INVALID_STRING ? json(404, { error: "unknown symbol" }) : json(200, { symbol: i.symbol, price: 0.31 })) } as GatewayClient;
    const llm = vi.fn().mockResolvedValue({ rules: [], listing: { summary: "s", description: "d", tags: ["t"] } }) as unknown as StructuredCall;
    await qaStep({ pool: db.pool, gateway, llm, webBaseUrl: WEB }, apiId);
    await deliver();
    expect(posted.at(-1)).toMatch(/^Step 6 of 7, Write the promise: Test calls done: .* Your promise to buyers: .* Reply `price 2` to accept it/);

    // Price by reply, the leak check, then the one-time publish link.
    await reply("price 2");
    const publish = await deliver();
    expect(leakCheck).toHaveBeenCalledWith(apiId);
    expect(publish).toMatch(/Leak check passed: your API refuses calls without its key\. Approve publishing at 2 tUSDM for 100 calls with your Cardano wallet \(one signature, no payment\): https:\/\/web\.test\/act\/[A-Za-z0-9_-]{43}\n\nSign with the wallet ending/);
    const { rows: acts } = await db.pool.query(`select action from act_tokens where api_id = $1 order by created_at`, [apiId]);
    expect(acts.map((a) => a.action)).toEqual(["ownership", "publish"]);

    // No comment ever pointed at the website's pages.
    for (const c of posted) {
      for (const link of c.match(/https?:\/\/\S+/g) ?? []) expect(link).toMatch(/^https:\/\/web\.test\/act\/[A-Za-z0-9_-]{43}$/);
      expect(c).not.toMatch(/[–—]/);
    }
  });
});
