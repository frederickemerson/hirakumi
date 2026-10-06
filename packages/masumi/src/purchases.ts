import { call } from "./http.js";
import { MasumiInputError } from "./errors.js";
import { MASUMI_ESCROW_UNIT, PAYMENT_SOURCE_TYPE, SUPPORTED_PAYMENT_SOURCE_INDEX } from "./constants.js";
import { AGENT_ID, HEX64, PURCHASER_ID, resolvePayment, toPaymentState } from "./payments.js";
import type { MasumiConfig, PaymentState } from "./types.js";

const VKEY = /^[0-9a-f]{56}$/i;

/**
 * Demo escrow buyer: locks Masumi tUSDM from this node's purchasing wallet.
 * The seller is this same node, so the signed smartContractAddress and sellerReturnAddress
 * come from the seller's own payment record. The node verifies the seller signature over them.
 */
export async function createPurchase(
  c: MasumiConfig,
  p: {
    agentIdentifier: string;
    blockchainIdentifier: string;
    inputHash: string;
    identifierFromPurchaser: string;
    sellerVKey: string;
    payByTime: Date;
    submitResultTime: Date;
    unlockTime: Date;
    externalDisputeUnlockTime: Date;
    amountMicros: bigint;
  },
): Promise<{ purchaseId: string }> {
  if (!AGENT_ID.test(p.agentIdentifier)) throw new MasumiInputError("agentIdentifier must be the registry asset id (hex)");
  if (!HEX64.test(p.inputHash)) throw new MasumiInputError("inputHash must be a 64-char hex sha256 (MIP-004)");
  if (!PURCHASER_ID.test(p.identifierFromPurchaser)) throw new MasumiInputError("identifierFromPurchaser must be 14-26 hex characters");
  if (!VKEY.test(p.sellerVKey)) throw new MasumiInputError("sellerVKey must be a 56-char hex payment key hash");
  if (p.amountMicros <= 0n) throw new MasumiInputError("amountMicros must be positive");

  const payment = await resolvePayment(c, p.blockchainIdentifier);
  const expected: Array<[string, string | null | undefined, string]> = [
    ["agentIdentifier", payment.agentIdentifier, p.agentIdentifier],
    ["inputHash", payment.inputHash, p.inputHash],
    ["sellerVKey", payment.SmartContractWallet?.walletVkey, p.sellerVKey],
    ["payByTime", payment.payByTime, String(p.payByTime.getTime())],
    ["submitResultTime", payment.submitResultTime, String(p.submitResultTime.getTime())],
    ["unlockTime", payment.unlockTime, String(p.unlockTime.getTime())],
    ["externalDisputeUnlockTime", payment.externalDisputeUnlockTime, String(p.externalDisputeUnlockTime.getTime())],
  ];
  const differing = expected.filter(([, seller, buyer]) => seller !== buyer).map(([name]) => name);
  if (differing.length > 0) {
    throw new MasumiInputError(`purchase terms differ from the seller's payment request: ${differing.join(", ")}`);
  }

  const purchase = await call<{ id: string }>(c.baseUrl, c.token, "POST", "/purchase", {
    body: {
      network: c.network,
      blockchainIdentifier: p.blockchainIdentifier,
      paymentSourceType: PAYMENT_SOURCE_TYPE,
      smartContractAddress: payment.PaymentSource.smartContractAddress,
      supportedPaymentSourceIndex: SUPPORTED_PAYMENT_SOURCE_INDEX,
      inputHash: p.inputHash,
      sellerVkey: p.sellerVKey,
      agentIdentifier: p.agentIdentifier,
      Amounts: [{ amount: p.amountMicros.toString(), unit: MASUMI_ESCROW_UNIT }],
      payByTime: String(p.payByTime.getTime()),
      submitResultTime: String(p.submitResultTime.getTime()),
      unlockTime: String(p.unlockTime.getTime()),
      externalDisputeUnlockTime: String(p.externalDisputeUnlockTime.getTime()),
      identifierFromPurchaser: p.identifierFromPurchaser,
      ...(payment.sellerReturnAddress ? { sellerReturnAddress: payment.sellerReturnAddress } : {}),
    },
  });
  return { purchaseId: purchase.id };
}

export async function getPurchaseState(c: MasumiConfig, blockchainIdentifier: string): Promise<PaymentState> {
  const purchase = await call<{ onChainState: string | null }>(c.baseUrl, c.token, "POST", "/purchase/resolve-blockchain-identifier", {
    body: { network: c.network, blockchainIdentifier },
  });
  return toPaymentState(purchase.onChainState);
}
