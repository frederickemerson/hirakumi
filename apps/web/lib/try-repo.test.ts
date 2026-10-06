import { beforeEach, describe, expect, it } from "vitest";
import { getSql } from "@/lib/db";
import { resetDb } from "@/test/db";
import { seedApi, seedOperation, seedSeller } from "@/test/factories";
import { demoBudgetProblem, demoCreditsLeft, listTryOperations } from "./try-repo";
import { sha256Hex } from "@hirakumi/core";
import { seedPack } from "@/test/factories";

describe("listTryOperations", () => {
  beforeEach(resetDb);

  it("lists only enabled endpoints of a live API, with their input schema", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "live");
    const on = await seedOperation(api.id, { opId: "getPrice", enabled: true });
    await seedOperation(api.id, { opId: "hidden", path: "/hidden", enabled: false });
    await getSql()`update operations set input_schema = ${getSql().json({ type: "object", required: ["symbol"] })} where id = ${on.id}`;
    const ops = await listTryOperations(getSql(), api.id);
    expect(ops).toEqual([expect.objectContaining({ opId: "getPrice", method: "GET", inputSchema: { type: "object", required: ["symbol"] } })]);
  });

  it("is empty for an API that is not live", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "intake");
    await seedOperation(api.id, { enabled: true });
    expect(await listTryOperations(getSql(), api.id)).toEqual([]);
  });
});

describe("demo pack budget", () => {
  beforeEach(resetDb);

  let n = 0;
  async function demo(remaining: number, status = "active") {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "live");
    const pack = await seedPack(api.id);
    n += 1;
    const token = { id: `ct_demo${n}`, raw: `hk_demo_${n}` };
    await getSql()`
      insert into credit_tokens (id, api_id, pack_id, token_hash, status, remaining, payment_payload_hash, tx_hash)
      values (${token.id}, ${api.id}, ${pack.id}, ${sha256Hex(token.raw)}, ${status}, ${remaining}, ${"pp" + n}, ${"tx" + n})`;
    return { api, token };
  }
  const seedTokenCall = (apiId: string, tokenId: string, i: number) => getSql()`
    insert into calls (id, kind, credit_token_id, api_id, op_id, execution, verdict)
    values (${`call_${tokenId}_${i}`}, 'credit', ${tokenId}, ${apiId}, 'getPrice', 'upstream_ok', 'pass')`;

  it("reads the credits left on the demo token, or null when it is unusable", async () => {
    const { token } = await demo(42);
    expect(await demoCreditsLeft(getSql(), token.raw)).toBe(42);
    expect(await demoCreditsLeft(getSql(), "hk_unknown")).toBeNull();
    const empty = await demo(0, "exhausted");
    expect(await demoCreditsLeft(getSql(), empty.token.raw)).toBeNull();
  });

  it("allows paid tries until the hourly cap of calls made with the demo token", async () => {
    const { api, token } = await demo(90);
    expect(await demoBudgetProblem(getSql(), token.raw, 3)).toBeNull();
    for (let i = 0; i < 3; i++) await seedTokenCall(api.id, token.id, i);
    expect(await demoBudgetProblem(getSql(), token.raw, 3)).toMatch(/this hour/);
  });

  it("explains an empty pack", async () => {
    const { token } = await demo(0, "exhausted");
    expect(await demoBudgetProblem(getSql(), token.raw, 3)).toMatch(/used up/);
  });
});
