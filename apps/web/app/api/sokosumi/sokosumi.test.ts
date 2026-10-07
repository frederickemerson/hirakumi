import { beforeEach, describe, expect, it } from "vitest";
import { getSql } from "@/lib/db";
import { resetDb } from "@/test/db";
import { seedApi, seedSeller } from "@/test/factories";
import { cookieFor, jsonRequest } from "@/test/requests";
import type { Seller } from "@/lib/types";
import { POST as createApi } from "../apis/route";
import { LINK_LIMIT } from "./rate-limit";
import { POST as link } from "./link/route";
import { POST as unlink } from "./unlink/route";

const USER = "usr_soko_1";

async function seedTask(token: string, user = USER) {
  await getSql()`insert into coworker_tasks (task_id, sokosumi_user_id, task_name, setup_token)
                 values (${"tsk_" + token}, ${user}, 'Put my API on the agent market', ${token})`;
  return "tsk_" + token;
}
const linkTo = (user: string | null, sellerId: string) => getSql()`update sellers set sokosumi_user_id = ${user} where id = ${sellerId}`;
const linkedUser = async (sellerId: string) =>
  (await getSql()<{ sokosumiUserId: string | null }[]>`select sokosumi_user_id from sellers where id = ${sellerId}`)[0].sokosumiUserId;
const ownerOf = async (apiId: string) =>
  (await getSql()<{ sellerId: string }[]>`select seller_id from apis where id = ${apiId}`)[0].sellerId;
const post = (route: typeof link, seller: Seller | null, body: unknown, headers: Record<string, string> = {}) => {
  const base = jsonRequest("/api/sokosumi/link", { cookie: seller ? cookieFor(seller) : undefined, body });
  const h = new Headers(base.headers);
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  return route(new Request(base.url, { method: "POST", headers: h, body: body === undefined ? undefined : JSON.stringify(body) }));
};
/** coworker_tasks hangs off no seller, so resetDb leaves it. */
const reset = async () => {
  await resetDb();
  await getSql()`delete from coworker_tasks`;
};
const messagesFor = (taskId: string) =>
  getSql()<{ body: string; sellerId: string }[]>`select body, seller_id from messages where task_id = ${taskId} order by id`;

describe("POST /api/sokosumi/link", () => {
  beforeEach(reset);

  it("moves the Sokosumi account and its listings that are not live yet, and tells each moved task", async () => {
    const oldSeller = await seedSeller();
    const me = await seedSeller("addr_test1qqmovetarget000000000000005vxkj4");
    await linkTo(USER, oldSeller.id);
    const t1 = await seedTask("tok_1");
    const t2 = await seedTask("tok_2");
    const t3 = await seedTask("tok_3");
    const draft = await seedApi(oldSeller.id, "parsed", { sokosumiTaskId: t1 });
    const priced = await seedApi(oldSeller.id, "priced", { sokosumiTaskId: t2 });
    const live = await seedApi(oldSeller.id, "live", { sokosumiTaskId: t3 });
    const registering = await seedApi(oldSeller.id, "registering", { sokosumiTaskId: t3 });
    const retired = await seedApi(oldSeller.id, "retired", { sokosumiTaskId: t3 });
    const unrelated = await seedApi(oldSeller.id, "parsed"); // not from a Sokosumi task

    const res = await post(link, me, { setupToken: "tok_1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ linked: true, already: false, moved: 2 });

    expect(await linkedUser(me.id)).toBe(USER);
    expect(await linkedUser(oldSeller.id)).toBeNull();
    expect(await ownerOf(draft.id)).toBe(me.id);
    expect(await ownerOf(priced.id)).toBe(me.id);
    for (const a of [live, registering, retired, unrelated]) expect(await ownerOf(a.id)).toBe(oldSeller.id);

    const m1 = await messagesFor(t1);
    expect(m1).toEqual([{ body: "Your Sokosumi account now uses wallet addr_test1qq…5vxkj4.", sellerId: me.id }]);
    expect(await messagesFor(t2)).toHaveLength(1);
    expect(await messagesFor(t3)).toHaveLength(0);
    expect(m1[0].body).not.toMatch(/[–—]/);
  });

  it("does not move another Sokosumi user's listings on the old wallet", async () => {
    const oldSeller = await seedSeller();
    const me = await seedSeller();
    await linkTo(USER, oldSeller.id);
    await seedTask("tok_1");
    const otherTask = await seedTask("tok_x", "usr_other");
    const theirs = await seedApi(oldSeller.id, "parsed", { sokosumiTaskId: otherTask });
    expect((await post(link, me, { setupToken: "tok_1" })).status).toBe(200);
    expect(await ownerOf(theirs.id)).toBe(oldSeller.id);
  });

  it("is idempotent: a second call changes nothing and posts no new message", async () => {
    const oldSeller = await seedSeller();
    const me = await seedSeller();
    await linkTo(USER, oldSeller.id);
    const t1 = await seedTask("tok_1");
    await seedApi(oldSeller.id, "parsed", { sokosumiTaskId: t1 });
    expect((await post(link, me, { setupToken: "tok_1" })).status).toBe(200);
    const again = await post(link, me, { setupToken: "tok_1" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ linked: true, already: true, moved: 0 });
    expect(await messagesFor(t1)).toHaveLength(1);
  });

  it("links an unlinked Sokosumi account without moving anything", async () => {
    const me = await seedSeller();
    await seedTask("tok_1");
    const res = await post(link, me, { setupToken: "tok_1" });
    expect(await res.json()).toEqual({ linked: true, already: false, moved: 0 });
    expect(await linkedUser(me.id)).toBe(USER);
  });

  it("refuses when this wallet is linked to a different Sokosumi account", async () => {
    const oldSeller = await seedSeller();
    const me = await seedSeller();
    await linkTo(USER, oldSeller.id);
    await linkTo("usr_other", me.id);
    await seedTask("tok_1");
    const res = await post(link, me, { setupToken: "tok_1" });
    expect(res.status).toBe(409);
    expect(await linkedUser(oldSeller.id)).toBe(USER);
    expect(await linkedUser(me.id)).toBe("usr_other");
  });

  it("refuses a missing or unknown setup token", async () => {
    const me = await seedSeller();
    expect((await post(link, me, {})).status).toBe(400);
    expect((await post(link, me, { setupToken: "" })).status).toBe(400);
    expect((await post(link, me, { setupToken: "nope" })).status).toBe(400);
    expect((await post(link, me, { setupToken: "a\u0000b" })).status).toBe(400);
    expect(await linkedUser(me.id)).toBeNull();
  });

  it("needs a signed-in session, and refuses cross-site requests", async () => {
    const oldSeller = await seedSeller();
    const me = await seedSeller();
    await linkTo(USER, oldSeller.id);
    await seedTask("tok_1");
    expect((await post(link, null, { setupToken: "tok_1" })).status).toBe(401);
    expect((await post(link, me, { setupToken: "tok_1" }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(await linkedUser(oldSeller.id)).toBe(USER);
  });

  it("is rate limited per seller", async () => {
    const me = await seedSeller();
    for (let i = 0; i < LINK_LIMIT; i++) expect((await post(link, me, { setupToken: "nope" })).status).toBe(400);
    expect((await post(link, me, { setupToken: "nope" })).status).toBe(429);
  });
});

describe("POST /api/sokosumi/unlink", () => {
  beforeEach(reset);

  it("unlinks only the signed-in seller, and its listings stay", async () => {
    const me = await seedSeller();
    const other = await seedSeller();
    await linkTo(USER, me.id);
    await linkTo("usr_other", other.id);
    const t1 = await seedTask("tok_1");
    const api = await seedApi(me.id, "parsed", { sokosumiTaskId: t1 });
    const res = await post(unlink, me, undefined);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ linked: false, changed: true });
    expect(await linkedUser(me.id)).toBeNull();
    expect(await linkedUser(other.id)).toBe("usr_other");
    expect(await ownerOf(api.id)).toBe(me.id);
    expect(await (await post(unlink, me, undefined)).json()).toEqual({ linked: false, changed: false });
  });

  it("needs a signed-in session, and refuses cross-site requests", async () => {
    const me = await seedSeller();
    await linkTo(USER, me.id);
    expect((await post(unlink, null, undefined)).status).toBe(401);
    expect((await post(unlink, me, undefined, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(await linkedUser(me.id)).toBe(USER);
  });
});

describe("POST /api/apis with a setup token, Sokosumi account linked elsewhere", () => {
  beforeEach(reset);

  it("refuses to create, and links nothing, until the account is moved", async () => {
    const oldSeller = await seedSeller();
    const me = await seedSeller();
    await linkTo(USER, oldSeller.id);
    await seedTask("tok_1");
    const req = jsonRequest("/api/apis", {
      cookie: cookieFor(me), body: { openapiUrl: "https://price.example.dev/openapi.json", name: "Price API", setupToken: "tok_1" },
    });
    const res = await createApi(req);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/linked to another wallet/);
    expect(await linkedUser(me.id)).toBeNull();
  });
});
