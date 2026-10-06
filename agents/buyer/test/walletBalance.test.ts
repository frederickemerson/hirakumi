import { describe, expect, it } from "vitest";
import { fetchWalletBalance } from "../src/walletBalance.js";
import { recoverPack } from "../src/packBuyer.js";

const BF = { baseUrl: "https://bf.test/api/v0/", projectId: "preprodX" };
const USDM_UNIT = "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c90014df10745553444d";

describe("fetchWalletBalance", () => {
  it("reads tADA and tUSDM from Blockfrost with the project id", async () => {
    let seen: { url: string; projectId: string | null } | null = null;
    const b = await fetchWalletBalance(async (url, init) => {
      seen = { url, projectId: new Headers(init?.headers).get("project_id") };
      return Response.json({ amount: [{ unit: "lovelace", quantity: "7250000" }, { unit: USDM_UNIT, quantity: "4000000" }] });
    }, BF, "addr_test1qxyz");
    expect(seen).toEqual({ url: "https://bf.test/api/v0/addresses/addr_test1qxyz", projectId: "preprodX" });
    expect(b).toEqual({ lovelace: 7_250_000n, usdmMicros: 4_000_000n });
  });

  it("an address that was never used holds nothing; other errors throw", async () => {
    expect(await fetchWalletBalance(async () => new Response("{}", { status: 404 }), BF, "addr_test1q")).toEqual({ lovelace: 0n, usdmMicros: 0n });
    await expect(fetchWalletBalance(async () => new Response("{}", { status: 500 }), BF, "addr_test1q")).rejects.toThrow(/500/);
  });
});

describe("recoverPack", () => {
  const saved = { packId: "pk_1", paymentSignature: "SIG", recoverySecret: "SECRET" };
  it("posts the signed payment and the secret, and returns the re-keyed token", async () => {
    const calls: { url: string; sig: string | null; secret: string | null }[] = [];
    const r = await recoverPack(async (url, init) => {
      const hd = new Headers(init?.headers);
      calls.push({ url, sig: hd.get("payment-signature"), secret: hd.get("x-hirakumi-recovery-secret") });
      return Response.json({ token: "hk_x", credits: 9, status: "pending" });
    }, "https://gw.test/", "api_1", saved);
    expect(calls).toEqual([{ url: "https://gw.test/a/api_1/packs/pk_1/recover", sig: "SIG", secret: "SECRET" }]);
    expect(r).toEqual({ kind: "recovered", token: "hk_x", credits: 9, pending: true });
  });
  it("maps 404, 403 and other answers", async () => {
    const at = (status: number) => recoverPack(async () => new Response("{}", { status }), "https://gw.test", "api_1", saved);
    expect(await at(404)).toEqual({ kind: "not_received" });
    expect(await at(403)).toEqual({ kind: "refused" });
    expect(await at(502)).toEqual({ kind: "failed", status: 502 });
  });
});
