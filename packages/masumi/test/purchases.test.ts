import { afterEach, describe, expect, it, vi } from "vitest";
import { createPurchase, getPurchaseState } from "../src/purchases.js";
import { MASUMI_ESCROW_UNIT } from "../src/constants.js";
import { MasumiInputError } from "../src/errors.js";
import type { MasumiConfig } from "../src/types.js";
import { installFakeFetch, ok } from "./fakeFetch.js";
import { paymentDto } from "./fixtures.js";

const C: MasumiConfig = { baseUrl: "http://ps.test/api/v1", token: "admin-key", network: "Preprod" };
const ESCROW = "addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g";
const seller = paymentDto();
const terms = {
  agentIdentifier: seller.agentIdentifier,
  blockchainIdentifier: "bc_1",
  inputHash: seller.inputHash,
  identifierFromPurchaser: "0123456789abcdef0123",
  sellerVKey: "c".repeat(56),
  payByTime: new Date(Number(seller.payByTime)),
  submitResultTime: new Date(Number(seller.submitResultTime)),
  unlockTime: new Date(Number(seller.unlockTime)),
  externalDisputeUnlockTime: new Date(Number(seller.externalDisputeUnlockTime)),
  amountMicros: 2_000_000n,
};

afterEach(() => vi.unstubAllGlobals());

describe("createPurchase", () => {
  it("locks funds from the purchasing wallet with the seller's signed terms", async () => {
    const returnAddr = "addr_test1qseller000000000000000000000000000000000000000000";
    const { calls } = installFakeFetch({
      "POST /api/v1/payment/resolve-blockchain-identifier": () => ok(paymentDto({ sellerReturnAddress: returnAddr })),
      "POST /api/v1/purchase": () => ok({ id: "pur_1" }),
    });
    await expect(createPurchase(C, terms)).resolves.toEqual({ purchaseId: "pur_1" });
    expect(calls.find((c) => c.url.pathname === "/api/v1/purchase")!.body).toEqual({
      network: "Preprod",
      blockchainIdentifier: "bc_1",
      paymentSourceType: "Web3CardanoV2",
      smartContractAddress: ESCROW,
      supportedPaymentSourceIndex: 0,
      inputHash: terms.inputHash,
      sellerVkey: "c".repeat(56),
      agentIdentifier: terms.agentIdentifier,
      Amounts: [{ amount: "2000000", unit: MASUMI_ESCROW_UNIT }],
      payByTime: seller.payByTime,
      submitResultTime: seller.submitResultTime,
      unlockTime: seller.unlockTime,
      externalDisputeUnlockTime: seller.externalDisputeUnlockTime,
      identifierFromPurchaser: "0123456789abcdef0123",
      sellerReturnAddress: returnAddr,
    });
  });

  it("omits sellerReturnAddress when the seller did not sign one", async () => {
    const { calls } = installFakeFetch({
      "POST /api/v1/payment/resolve-blockchain-identifier": () => ok(paymentDto()),
      "POST /api/v1/purchase": () => ok({ id: "pur_2" }),
    });
    await createPurchase(C, terms);
    expect(calls.find((c) => c.url.pathname === "/api/v1/purchase")!.body).not.toHaveProperty("sellerReturnAddress");
  });

  it("refuses terms that differ from the seller's payment request", async () => {
    const { calls } = installFakeFetch({
      "POST /api/v1/payment/resolve-blockchain-identifier": () => ok(paymentDto()),
    });
    const stale = { ...terms, submitResultTime: new Date(terms.submitResultTime.getTime() + 60_000) };
    await expect(createPurchase(C, stale)).rejects.toThrow(/submitResultTime/);
    expect(calls.some((c) => c.url.pathname === "/api/v1/purchase")).toBe(false);
  });

  it("rejects malformed inputs before any call", async () => {
    const { calls } = installFakeFetch({});
    for (const bad of [{ ...terms, amountMicros: 0n }, { ...terms, sellerVKey: "xyz" }, { ...terms, identifierFromPurchaser: "zz" }]) {
      await expect(createPurchase(C, bad)).rejects.toBeInstanceOf(MasumiInputError);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("getPurchaseState", () => {
  it("reads the buyer-side record", async () => {
    const { calls } = installFakeFetch({
      "POST /api/v1/purchase/resolve-blockchain-identifier": () => ok({ onChainState: "RefundWithdrawn" }),
    });
    await expect(getPurchaseState(C, "bc_1")).resolves.toBe("RefundWithdrawn");
    expect(calls[0].body).toEqual({ network: "Preprod", blockchainIdentifier: "bc_1" });
  });
});
