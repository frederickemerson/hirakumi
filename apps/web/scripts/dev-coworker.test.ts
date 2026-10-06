import { beforeEach, describe, expect, it } from "vitest";
import { getSql } from "@/lib/db";
import { resetDb } from "@/test/db";
import { seedApi, seedSeller } from "@/test/factories";
import { fakeBuildRules, fakeGoLive, fakeParse } from "./dev-coworker";

describe("dev coworker", () => {
  beforeEach(resetDb);

  it("parses: intake -> described with three blocked operations", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "intake");
    await fakeParse(getSql(), api.id);
    const ops = await getSql()<{ opId: string; enabled: boolean }[]>`select op_id, enabled from operations where api_id = ${api.id} order by op_id`;
    expect(ops.map((o) => o.opId)).toEqual(["getHistory", "getPrice", "refreshCache"]);
    expect(ops.every((o) => !o.enabled)).toBe(true);
    const [row] = await getSql()<{ state: string }[]>`select state from apis where id = ${api.id}`;
    expect(row.state).toBe("described");
  });

  it("builds one promise per enabled operation and moves to rule_built", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "intake");
    await fakeParse(getSql(), api.id);
    await getSql()`update operations set enabled = true where api_id = ${api.id} and op_id = 'getPrice'`;
    await getSql()`update apis set state = 'ownership_verified' where id = ${api.id}`;
    await fakeBuildRules(getSql(), api.id);
    const [{ count }] = await getSql()<{ count: number }[]>`
      select count(*)::int as count from rules r join operations o on o.id = r.operation_id where o.api_id = ${api.id}`;
    expect(count).toBe(1);
    const [row] = await getSql()<{ state: string }[]>`select state from apis where id = ${api.id}`;
    expect(row.state).toBe("rule_built");
  });

  it("refuses to run from the wrong state", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "priced");
    await expect(fakeParse(getSql(), api.id)).rejects.toThrow("fakeParse needs state intake or parsed, got priced");
    await expect(fakeGoLive(getSql(), api.id)).rejects.toThrow("fakeGoLive needs state registering");
  });
});
