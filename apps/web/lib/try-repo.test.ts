import { beforeEach, describe, expect, it } from "vitest";
import { getSql } from "@/lib/db";
import { resetDb } from "@/test/db";
import { seedApi, seedOperation, seedSeller } from "@/test/factories";
import { demoBudgetProblem, findTryPack, listTryOperations } from "./try-repo";
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

  /** A pack the gateway bought live for this API, as POST /internal/demo/buy-pack stores it. */
  const liveRow = (apiId: string, raw: string, ago: string, status = "active") => getSql()`
    insert into try_tokens (id, api_id, status, token, token_hash, tx_hash, credits, created_at)
    values (${`try_${raw}`}, ${apiId}, ${status}, ${raw}, ${sha256Hex(raw)}, ${"live_" + raw}, 100, now() - ${ago}::interval)`;

  it("uses the newest live pack with credits from try_tokens, ahead of the TRY_CREDIT_TOKENS one", async () => {
    const { api, token } = await demo(42);
    await liveRow(api.id, token.raw, "1 minute");
    const pack = await findTryPack(getSql(), api.id, "hk_env_fallback");
    expect(pack).toMatchObject({ token: token.raw, creditTokenId: token.id, remaining: 42, pending: false, txHash: `live_${token.raw}`, source: "live" });
  });

  it("skips a live pack that is used up and falls back to the env token", async () => {
    const { api, token } = await demo(0, "exhausted");
    await liveRow(api.id, token.raw, "1 minute");
    expect(await findTryPack(getSql(), api.id, undefined)).toBeNull();
    const envToken = "hk_env_token";
    await getSql()`
      insert into credit_tokens (id, api_id, pack_id, token_hash, status, remaining, payment_payload_hash, tx_hash)
      select 'ct_env', ${api.id}, pack_id, ${sha256Hex(envToken)}, 'active', 7, 'pp_env', 'tx_env' from credit_tokens where id = ${token.id}`;
    expect(await findTryPack(getSql(), api.id, envToken)).toMatchObject({ token: envToken, remaining: 7, source: "env" });
    // Receipts stay readable after the credits run out.
    expect(await findTryPack(getSql(), api.id, undefined, { withCredits: false })).toMatchObject({ token: token.raw, remaining: 0 });
  });

  it("a settling pack is usable and says so; a buying or unsettled attempt is not a pack", async () => {
    const { api, token } = await demo(100, "pending");
    await liveRow(api.id, token.raw, "1 minute");
    expect(await findTryPack(getSql(), api.id, undefined)).toMatchObject({ pending: true, remaining: 100 });
    const other = await demo(100);
    await getSql()`insert into try_tokens (id, api_id, status) values ('try_buying', ${other.api.id}, 'buying')`;
    expect(await findTryPack(getSql(), other.api.id, undefined)).toBeNull();
  });

  it("never returns another API's pack or token", async () => {
    const a = await demo(10);
    const b = await demo(10);
    await liveRow(a.api.id, a.token.raw, "1 minute");
    expect(await findTryPack(getSql(), b.api.id, a.token.raw)).toBeNull();
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
