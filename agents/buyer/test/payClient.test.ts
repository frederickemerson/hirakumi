import { describe, it, expect } from "vitest";
import { x402Client, type PaymentRequired, type SchemeNetworkClient } from "@x402/fetch";
import { USDM_PREPROD_ASSET, findDefaultAsset } from "@x402/cardano";
import { spendControlsFor, SerialPayer } from "../src/payClient.js";

// A scheme that never signs: it only reports the cap the client resolved.
function fakeScheme(): SchemeNetworkClient {
  return {
    scheme: "exact",
    findDefaultAsset,
    async createPaymentPayload(v, _req, ctx) {
      return { x402Version: v, payload: { cap: ctx?.maxAmountPerPayment ?? null } };
    },
  };
}
const required = (amount: string, asset = USDM_PREPROD_ASSET): PaymentRequired => ({
  x402Version: 2,
  resource: { url: "https://gw.test/a/api_demo/packs/pk_demo" },
  accepts: [{ scheme: "exact", network: "cardano:preprod", asset, amount, payTo: "addr_test1qz0000", maxTimeoutSeconds: 600, extra: {} }],
});
function clientWith(controls?: ReturnType<typeof spendControlsFor>) {
  const c = new x402Client();
  if (controls) c.setSpendControls(controls);
  c.register("cardano:*", fakeScheme());
  return c;
}

describe("spend controls", () => {
  it("the default controls refuse a 2 tUSDM pack (the $1 trap)", async () => {
    await expect(clientWith().createPaymentPayload(required("2000000"))).rejects.toThrow(/\$1/);
  });

  it("allows a 2 tUSDM pack and refuses 6 tUSDM under a 5 tUSDM cap", async () => {
    const ok = await clientWith(spendControlsFor(5_000_000n)).createPaymentPayload(required("2000000"));
    expect(ok.payload).toEqual({ cap: "5000000" });
    await expect(clientWith(spendControlsFor(5_000_000n)).createPaymentPayload(required("6000000"))).rejects.toThrow(/maxAmountPerPayment/);
  });

  it("never pays in lovelace", async () => {
    await expect(clientWith(spendControlsFor(5_000_000n)).createPaymentPayload(required("2000000", "lovelace"))).rejects.toThrow(/spendControls/);
  });

  it("rejects a non-positive cap", () => {
    expect(() => spendControlsFor(0n)).toThrow();
  });
});

describe("SerialPayer", () => {
  it("never runs two payments at once", async () => {
    const payer = new SerialPayer();
    let inFlight = 0;
    let maxInFlight = 0;
    const task = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return "done";
    };
    await Promise.all([payer.run(task), payer.run(task), payer.run(task)]);
    expect(maxInFlight).toBe(1);
  });

  it("keeps going after a failed payment", async () => {
    const payer = new SerialPayer();
    await expect(payer.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(payer.run(async () => 42)).resolves.toBe(42);
  });
});
