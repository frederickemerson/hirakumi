import { beforeEach, describe, expect, it } from "vitest";
import { getSql } from "@/lib/db";
import { resetDb } from "@/test/db";
import { seedApi, seedSeller } from "@/test/factories";
import { getOrCreateVerifyCode } from "./challenges";

describe("getOrCreateVerifyCode (the ownership page calls it on every load)", () => {
  beforeEach(resetDb);

  it("concurrent page loads get one code, stored once", async () => {
    const api = await seedApi((await seedSeller()).id, "endpoints_confirmed");
    const codes = await Promise.all(Array.from({ length: 8 }, () => getOrCreateVerifyCode(getSql(), api.id)));
    expect(new Set(codes.map((c) => c.code)).size).toBe(1);
    const [row] = await getSql()<{ n: number }[]>`select count(*)::int as n from challenges where api_id = ${api.id} and kind = 'openapi'`;
    expect(row.n).toBe(1);
  });

  it("the database itself refuses a second open code for the same API", async () => {
    const api = await seedApi((await seedSeller()).id, "endpoints_confirmed");
    await getOrCreateVerifyCode(getSql(), api.id);
    await expect(getSql()`
      insert into challenges (id, api_id, kind, token, expires_at)
      values ('ch_dupe', ${api.id}, 'openapi', 'hkv_other', now() + interval '1 day')`).rejects.toThrow(/challenges_openapi_open_per_api/);
  });
});
