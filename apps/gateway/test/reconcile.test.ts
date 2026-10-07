import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blockfrostLookup, paidTo, Reconciler, USDM_PREPROD_UNIT, type ChainLookup } from "../src/reconcile";
import { insertActiveToken, makeHarness, type Harness } from "./helpers";

let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(async () => { await h.close(); });

async function pendingWithTx(tx: string, ageMinutes = 10) {
  const t = await insertActiveToken(h.sql, h.seeded, 100, "pending");
  await h.sql`update credit_tokens set tx_hash = ${tx}, created_at = now() - (${ageMinutes} * interval '1 minute') where id = ${t.id}`;
  return t.id;
}
const statusOf = async (id: string) => (await h.sql<{ status: string }[]>`select status from credit_tokens where id = ${id}`)[0].status;

describe("Reconciler", () => {
  it("activates a pending token whose tx pays the seller the pack price", async () => {
    const id = await pendingWithTx("aa".repeat(32));
    const lookup: ChainLookup = async () => ({ found: true, outputs: [
      { address: h.seeded.payTo, amount: [{ unit: "lovelace", quantity: "1400000" }, { unit: USDM_PREPROD_UNIT, quantity: "2000000" }] },
    ] });
    expect(await new Reconciler({ sql: h.sql, lookup }).tick()).toEqual({ checked: 1, activated: 1 });
    expect(await statusOf(id)).toBe("active");
  });
  it("leaves it pending when the tx is unknown, underpays, or pays someone else", async () => {
    const id = await pendingWithTx("bb".repeat(32));
    const cases: ChainLookup[] = [
      async () => ({ found: false }),
      async () => ({ found: true, outputs: [{ address: h.seeded.payTo, amount: [{ unit: USDM_PREPROD_UNIT, quantity: "1999999" }] }] }),
      async () => ({ found: true, outputs: [{ address: "addr_test1qsomeoneelse", amount: [{ unit: USDM_PREPROD_UNIT, quantity: "2000000" }] }] }),
    ];
    for (const lookup of cases) await new Reconciler({ sql: h.sql, lookup }).tick();
    expect(await statusOf(id)).toBe("pending");
  });
  it("revokes a pending payment that never landed after its validity window, so dead rows can't starve the queue", async () => {
    const dead = await pendingWithTx("dd".repeat(32), 120);
    const recent = await pendingWithTx("ee".repeat(32), 10);
    const lookup: ChainLookup = async () => ({ found: false });
    await new Reconciler({ sql: h.sql, lookup }).tick();
    expect(await statusOf(dead)).toBe("revoked");
    expect(await statusOf(recent)).toBe("pending");
  });
  it("one failed lookup doesn't stop the rest of the tick", async () => {
    const broken = await pendingWithTx("ff".repeat(32), 12);
    const good = await pendingWithTx("aa".repeat(32), 10);
    const lookup: ChainLookup = async (tx) => {
      if (tx === "ff".repeat(32)) throw new Error("blockfrost 500");
      return { found: true, outputs: [{ address: h.seeded.payTo, amount: [{ unit: USDM_PREPROD_UNIT, quantity: "2000000" }] }] };
    };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await new Reconciler({ sql: h.sql, lookup }).tick()).toEqual({ checked: 2, activated: 1 });
    err.mockRestore();
    expect(await statusOf(broken)).toBe("pending");
    expect(await statusOf(good)).toBe("active");
  });
  it("ignores tokens younger than minAgeSeconds (the settle hook gets the first chance)", async () => {
    await pendingWithTx("cc".repeat(32), 0);
    let calls = 0;
    const lookup: ChainLookup = async () => { calls += 1; return { found: false }; };
    expect(await new Reconciler({ sql: h.sql, lookup, minAgeSeconds: 120 }).tick()).toEqual({ checked: 0, activated: 0 });
    expect(calls).toBe(0);
  });
});

describe("blockfrostLookup and paidTo", () => {
  it("maps 404 to not found and 200 to outputs, sending the project id", async () => {
    const seen: Array<{ url: string; key: string | null }> = [];
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), key: new Headers(init?.headers).get("project_id") });
      return String(url).includes("/txs/00")
        ? new Response("{}", { status: 404 })
        : new Response(JSON.stringify({ outputs: [{ address: "addr_test1qx", amount: [{ unit: "lovelace", quantity: "5" }], output_index: 0 }] }), { status: 200 });
    }) as typeof fetch;
    const look = blockfrostLookup("preprodKEY", "https://bf.test", fake);
    expect(await look("00ff")).toEqual({ found: false });
    expect(await look("11ff")).toEqual({ found: true, outputs: [{ address: "addr_test1qx", amount: [{ unit: "lovelace", quantity: "5" }] }] });
    expect(seen[1]).toEqual({ url: "https://bf.test/txs/11ff/utxos", key: "preprodKEY" });
  });
  it("paidTo sums one unit across outputs to one address", () => {
    expect(paidTo([
      { address: "a", amount: [{ unit: "u", quantity: "2" }] },
      { address: "a", amount: [{ unit: "u", quantity: "3" }, { unit: "v", quantity: "9" }] },
      { address: "b", amount: [{ unit: "u", quantity: "7" }] },
    ], "a", "u")).toBe(5n);
  });
});
