import { beforeEach, describe, expect, it } from "vitest";
import { getSql } from "@/lib/db";
import { resetDb } from "@/test/db";
import { seedApi, seedSeller } from "@/test/factories";
import { listChat } from "./chat";

beforeEach(async () => { await resetDb(); });

describe("listChat (review I4: coworker messages carry no seller_id)", () => {
  it("shows coworker messages inserted exactly as the coworker inserts them (api_id only)", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "described");
    await getSql()`insert into messages (api_id, task_id, author, body, dedupe_key) values (${api.id}, null, 'coworker', 'Found 1 endpoint.', ${"d1-" + api.id})`;
    const rows = await listChat(getSql(), seller.id, api.id, 0);
    expect(rows.map((r) => r.body)).toEqual(["Found 1 endpoint."]);
  });
  it("never shows another seller's API thread", async () => {
    const mine = await seedSeller();
    const theirs = await seedSeller();
    const api = await seedApi(theirs.id, "described");
    await getSql()`insert into messages (api_id, author, body) values (${api.id}, 'coworker', 'private')`;
    expect(await listChat(getSql(), mine.id, api.id, 0)).toEqual([]);
  });
});
