import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inferTextRule, ruleHash, withRequiredPhrase, type RuleDefinition } from "@hirakumi/core";
import { getSql } from "@/lib/db";
import { setGatewayForTests, type Gateway } from "@/lib/gateway";
import { listLatestRules } from "@/lib/repo/rules";
import type { Api, Operation, Seller } from "@/lib/types";
import { resetDb } from "@/test/db";
import { seedApi, seedOperation, seedRule, seedSeller } from "@/test/factories";
import { cookieFor, ctx, jsonRequest } from "@/test/requests";
import { POST } from "./route";

const TEXT_RULE: RuleDefinition = inferTextRule("text/plain", ["BTC 64000", "ETH 3100"]);
const PLAIN = "Every answer is plain text.";

let seller: Seller;
let api: Api;
let op: Operation;
const reloadApi = vi.fn(async () => undefined);

async function setup(state: Api["state"], definition: RuleDefinition = TEXT_RULE) {
  seller = await seedSeller();
  api = await seedApi(seller.id, state);
  op = await seedOperation(api.id, { enabled: true });
  await seedRule(op.id, { definition, plainEnglish: PLAIN });
}
function addPhrase(phrase: unknown, cookie = cookieFor(seller), operationId = op.id) {
  return POST(jsonRequest(`/api/apis/${api.id}/promise-phrase`, { cookie, body: { operationId, phrase } }), ctx(api.id));
}
async function versions() {
  return getSql()<{ version: number; hash: string; plainEnglish: string | null }[]>`
    select version, hash, plain_english from rules where operation_id = ${op.id} order by version`;
}

describe("Every good answer contains (text promises)", () => {
  beforeEach(async () => {
    await resetDb();
    reloadApi.mockClear();
    setGatewayForTests({ checkChallenge: vi.fn(), reloadApi, getHealth: vi.fn(), getSettlement: vi.fn() } as Gateway);
  });
  afterEach(() => setGatewayForTests(null));

  it("a status-only text promise is shown as one, with no phrases", async () => {
    await setup("rule_built");
    const [view] = await listLatestRules(getSql(), api.id);
    expect(view).toMatchObject({ statusOnly: true, requiredPhrases: [] });
  });

  it.each(["rule_built", "priced"] as const)("at %s saves a new promise version that requires the phrase", async (state) => {
    await setup(state);
    const res = await addPhrase("  USD  ");
    expect(res.status).toBe(200);
    const expected = withRequiredPhrase(TEXT_RULE, "USD");
    const rows = await versions();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({ version: 2, hash: ruleHash(expected), plainEnglish: `${PLAIN} Every good answer contains "USD".` });
    const [view] = await listLatestRules(getSql(), api.id);
    expect(view).toMatchObject({ version: 2, hash: ruleHash(expected), statusOnly: false, requiredPhrases: ["USD"] });
    expect(view.definition).toEqual(expected);
    expect(reloadApi).toHaveBeenCalledWith(api.id);

    // The same phrase again changes nothing; a second phrase adds a third version.
    expect((await addPhrase("USD")).status).toBe(200);
    expect(await versions()).toHaveLength(2);
    expect((await addPhrase("price")).status).toBe(200);
    const [latest] = await listLatestRules(getSql(), api.id);
    expect(latest).toMatchObject({ version: 3, requiredPhrases: ["USD", "price"] });
  });

  it("refuses a phrase one of the stored good test answers lacks, in any case it is typed", async () => {
    await setup("rule_built");
    const answers = [{ body: "BTC price: 64000 USD", complete: true }, { body: "ETH price: 3100 USD", complete: true }, { body: `BTC ${"x".repeat(50)}`, complete: false }];
    await getSql()`insert into onboard_steps (api_id, step, status, attempts, output)
      values (${api.id}, 'qa', 'done', 0, ${getSql().json({ goodAnswers: { [op.opId]: answers } })})`;
    const res = await addPhrase("BTC");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Not every good answer from your test calls contains "BTC", so the promise would refuse your own answers. Pick a word or label every answer has.',
    });
    expect(await versions()).toHaveLength(1);
    // Every whole answer has it in another case; the cut answer does not count.
    expect((await addPhrase("PRICE:")).status).toBe(200);
    expect((await listLatestRules(getSql(), api.id))[0]).toMatchObject({ version: 2, requiredPhrases: ["PRICE:"] });
  });

  it("drops the status-only sentence from the promise text once a phrase is saved", async () => {
    seller = await seedSeller();
    api = await seedApi(seller.id, "rule_built");
    op = await seedOperation(api.id, { enabled: true });
    await seedRule(op.id, { definition: TEXT_RULE, plainEnglish: `${PLAIN} This is a status-only promise: it does not check the content.` });
    expect((await addPhrase("USD")).status).toBe(200);
    expect((await versions())[1].plainEnglish).toBe(`${PLAIN} Every good answer contains "USD".`);
  });

  it("refuses once the listing is registering or live: the promise is published", async () => {
    for (const state of ["registering", "live"] as const) {
      await resetDb();
      await setup(state);
      const res = await addPhrase("USD");
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "Your promise is published, so it can't change any more." });
      expect(await versions()).toHaveLength(1);
    }
  });

  it("refuses a JSON promise and a bad phrase in plain words", async () => {
    await setup("rule_built");
    for (const bad of ["", "two\nlines", "x".repeat(201)]) {
      const res = await addPhrase(bad);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/phrase/);
    }
    expect((await addPhrase(42)).status).toBe(400);

    await resetDb();
    await setup("rule_built", {
      version: 1, status: { min: 200, max: 299 }, contentType: "application/json", schema: { type: "object", required: ["price"] },
    });
    const json = await addPhrase("USD");
    expect(json.status).toBe(400);
    expect(await json.json()).toEqual({ error: "A required phrase only works for promises on text answers." });
    expect(await versions()).toHaveLength(1);
  });

  it("refuses another seller's API, and an operation of another API", async () => {
    await setup("rule_built");
    expect((await addPhrase("USD", cookieFor(await seedSeller()))).status).toBe(404);
    const otherApi = await seedApi(seller.id, "rule_built");
    const otherOp = await seedOperation(otherApi.id, { enabled: true });
    await seedRule(otherOp.id, { definition: TEXT_RULE });
    expect((await addPhrase("USD", cookieFor(seller), otherOp.id)).status).toBe(404);
    expect(await versions()).toHaveLength(1);
  });
});
