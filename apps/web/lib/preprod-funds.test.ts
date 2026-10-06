import { describe, expect, it, vi } from "vitest";
import { createPreprodFundsHandler, preprodFunds } from "./preprod-funds";

const BASE = "https://bf.test/api/v0";
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const notFound = () => json({ status_code: 404, error: "Not Found" }, 404);

// A testnet base address in hex, the form a CIP-30 wallet hands out.
const HEX = "00" + "11".repeat(28) + "22".repeat(28);

describe("preprodFunds", () => {
  it("is funded when any address holds lovelace", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(notFound())
      .mockResolvedValueOnce(json({ amount: [{ unit: "lovelace", quantity: "18118690" }] }));
    expect(await preprodFunds({ projectId: "preprodX", baseUrl: BASE, fetchImpl }, ["addr_a", "addr_b"])).toBe("funded");
    expect(fetchImpl.mock.calls[0][0]).toBe(`${BASE}/addresses/addr_a`);
    expect(fetchImpl.mock.calls[0][1].headers).toEqual({ project_id: "preprodX" });
  });

  it("is empty when Blockfrost has never seen the addresses or they hold nothing", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(notFound())
      .mockResolvedValueOnce(json({ amount: [{ unit: "lovelace", quantity: "0" }] }));
    expect(await preprodFunds({ projectId: "p", baseUrl: BASE, fetchImpl }, ["a", "b"])).toBe("empty");
  });

  it("does not claim empty when a lookup failed or there is no key", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(notFound()).mockResolvedValueOnce(json({}, 500));
    expect(await preprodFunds({ projectId: "p", baseUrl: BASE, fetchImpl }, ["a", "b"])).toBe("unknown");
    expect(await preprodFunds({ projectId: undefined, baseUrl: BASE, fetchImpl }, ["a"])).toBe("unknown");
  });
});

describe("POST /api/wallet/preprod-funds", () => {
  const post = (body: unknown) =>
    new Request("https://web.test/api/wallet/preprod-funds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("converts wallet hex to preprod bech32 and answers with a status only", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(notFound());
    const handler = createPreprodFundsHandler({ projectId: "p", baseUrl: BASE, fetchImpl, allow: () => true });
    const res = await handler(post({ addresses: [HEX, HEX] }));
    expect(await res.json()).toEqual({ status: "empty" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toMatch(/\/addresses\/addr_test1/);
  });

  it("rejects a request without addresses and rate-limits quietly", async () => {
    const handler = createPreprodFundsHandler({ projectId: "p", baseUrl: BASE, fetchImpl: vi.fn(), allow: () => false });
    expect((await handler(post({}))).status).toBe(400);
    expect(await (await handler(post({ addresses: [HEX] }))).json()).toEqual({ status: "unknown" });
  });
});
