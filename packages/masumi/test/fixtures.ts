export const NOW = Date.parse("2026-10-07T03:00:00.000Z");
export const MIN = 60_000;
export const AGENT_ID = "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b" + "1".repeat(64);
export const INPUT_HASH = "b".repeat(64);
export const PURCHASER = "0123456789abcdef0123";
export const ESCROW = "addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g";
export const payBy = new Date(NOW + 10 * MIN);
export const submit = new Date(NOW + 20 * MIN);
export const unlock = new Date(submit.getTime() + 16 * MIN);
export const dispute = new Date(unlock.getTime() + 16 * MIN);

/** A /payment or /payment/resolve-blockchain-identifier `data` object as the node returns it. */
export const paymentDto = (over: Record<string, unknown> = {}) => ({
  id: "pay_1",
  blockchainIdentifier: "bc_1",
  agentIdentifier: AGENT_ID,
  inputHash: INPUT_HASH,
  payByTime: String(payBy.getTime()),
  submitResultTime: String(submit.getTime()),
  unlockTime: String(unlock.getTime()),
  externalDisputeUnlockTime: String(dispute.getTime()),
  onChainState: null as string | null,
  sellerReturnAddress: null as string | null,
  RequestedFunds: [{ amount: "2000000", unit: "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d" }],
  SmartContractWallet: { walletVkey: "c".repeat(56), walletAddress: "addr_test1qsell" },
  PaymentSource: { network: "Preprod", paymentSourceType: "Web3CardanoV2", smartContractAddress: ESCROW },
  NextAction: { requestedAction: "WaitingForExternalAction", errorType: null, errorNote: null },
  ...over,
});
