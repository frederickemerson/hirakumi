import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPaymentRequest, getPaymentState, submitResult } from "../src/payments.js";
import { MasumiInputError } from "../src/errors.js";
import type { MasumiConfig } from "../src/types.js";
import { installFakeFetch, ok } from "./fakeFetch.js";
import { AGENT_ID, INPUT_HASH, MIN, NOW, PURCHASER, dispute, payBy, paymentDto, submit, unlock } from "./fixtures.js";

const C: MasumiConfig = { baseUrl: "http://ps.test/api/v1", token: "admin-key", network: "Preprod" };
const request = { agentIdentifier: AGENT_ID, inputHash: INPUT_HASH, identifierFromPurchaser: PURCHASER, payByTime: payBy, submitResultTime: submit };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("createPaymentRequest", () => {
  it("creates a V2 payment request with unlock and dispute times the node accepts", async () => {
    const { calls } = installFakeFetch({ "POST /api/v1/payment": () => ok(paymentDto()) });
    await expect(createPaymentRequest(C, request)).resolves.toEqual({
      blockchainIdentifier: "bc_1",
      payByTime: payBy,
      submitResultTime: submit,
      unlockTime: unlock,
      externalDisputeUnlockTime: dispute,
      sellerVKey: "c".repeat(56),
    });
    expect(calls[0].body).toEqual({
      network: "Preprod",
      agentIdentifier: AGENT_ID,
      inputHash: INPUT_HASH,
      identifierFromPurchaser: PURCHASER,
      paymentSourceType: "Web3CardanoV2",
      supportedPaymentSourceIndex: 0,
      payByTime: payBy.toISOString(),
      submitResultTime: submit.toISOString(),
      unlockTime: unlock.toISOString(),
      externalDisputeUnlockTime: dispute.toISOString(),
    });
  });

  it("forwards sellerReturnAddress so escrow earnings go to the seller", async () => {
    const seller = "addr_test1qseller000000000000000000000000000000000000000000";
    const { calls } = installFakeFetch({ "POST /api/v1/payment": () => ok(paymentDto({ sellerReturnAddress: seller })) });
    await createPaymentRequest(C, { ...request, sellerReturnAddress: seller });
    expect((calls[0].body as { sellerReturnAddress: string }).sellerReturnAddress).toBe(seller);
  });

  it("rejects deadlines the node would refuse, before calling it", async () => {
    const { calls } = installFakeFetch({});
    const cases = [
      { ...request, submitResultTime: new Date(NOW + 15 * MIN) },
      { ...request, payByTime: new Date(submit.getTime() - 4 * MIN) },
      { ...request, payByTime: new Date(NOW - MIN) },
    ];
    for (const c of cases) await expect(createPaymentRequest(C, c)).rejects.toBeInstanceOf(MasumiInputError);
    expect(calls).toHaveLength(0);
  });

  it("rejects identifiers and addresses the node would refuse", async () => {
    const { calls } = installFakeFetch({});
    const cases = [
      { ...request, identifierFromPurchaser: "not-hex-not-hex-not" },
      { ...request, identifierFromPurchaser: "0123456789abc" },
      { ...request, identifierFromPurchaser: "0".repeat(27) },
      { ...request, inputHash: "b".repeat(63) },
      { ...request, agentIdentifier: "abc" },
      { ...request, sellerReturnAddress: "addr1qmainnet" },
    ];
    for (const c of cases) await expect(createPaymentRequest(C, c)).rejects.toBeInstanceOf(MasumiInputError);
    expect(calls).toHaveLength(0);
  });
});

describe("getPaymentState", () => {
  it.each([
    [null, "WaitingForPayment"],
    ["FundsLocked", "FundsLocked"],
    ["ResultSubmitted", "ResultSubmitted"],
    ["RefundRequested", "RefundRequested"],
    ["Disputed", "Disputed"],
    ["Withdrawn", "Withdrawn"],
    ["RefundWithdrawn", "RefundWithdrawn"],
    ["FundsOrDatumInvalid", "Other"],
    ["RefundAuthorized", "Other"],
    ["DisputedWithdrawn", "Other"],
  ])("maps onChainState %s to %s", async (onChainState, expected) => {
    const { calls } = installFakeFetch({
      "POST /api/v1/payment/resolve-blockchain-identifier": () => ok(paymentDto({ onChainState })),
    });
    await expect(getPaymentState(C, "bc_1")).resolves.toBe(expected);
    expect(calls[0].body).toEqual({ network: "Preprod", blockchainIdentifier: "bc_1" });
  });
});

describe("submitResult", () => {
  it("submits the 64-hex MIP-004 output hash", async () => {
    const hash = "d".repeat(64);
    const { calls } = installFakeFetch({ "POST /api/v1/payment/submit-result": () => ok(paymentDto()) });
    await submitResult(C, "bc_1", hash);
    expect(calls[0].body).toEqual({ network: "Preprod", blockchainIdentifier: "bc_1", submitResultHash: hash });
  });

  it("rejects a 128-hex input+output hash (the node only accepts 64 hex)", async () => {
    const { calls } = installFakeFetch({});
    await expect(submitResult(C, "bc_1", "a".repeat(64) + "b".repeat(64))).rejects.toThrow(/64-char hex/);
    expect(calls).toHaveLength(0);
  });
});
