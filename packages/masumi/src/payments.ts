import { call } from "./http.js";
import { MasumiApiError, MasumiInputError } from "./errors.js";
import {
  DISPUTE_AFTER_UNLOCK_MS,
  MIN_PAYBY_GAP_MS,
  MIN_SUBMIT_LEAD_MS,
  PAYMENT_SOURCE_TYPE,
  SUPPORTED_PAYMENT_SOURCE_INDEX,
  UNLOCK_AFTER_SUBMIT_MS,
} from "./constants.js";
import type { MasumiConfig, PaymentState } from "./types.js";

export const HEX64 = /^[0-9a-f]{64}$/i;
/** Node rule (payments/schemas.ts): identifierFromPurchaser is 14–26 hex characters. */
export const PURCHASER_ID = /^[0-9a-f]{14,26}$/i;
export const AGENT_ID = /^[0-9a-f]{57,250}$/i;

export type PaymentDto = {
  id: string;
  blockchainIdentifier: string;
  agentIdentifier: string | null;
  inputHash: string | null;
  payByTime: string | null;
  submitResultTime: string;
  unlockTime: string;
  externalDisputeUnlockTime: string;
  onChainState: string | null;
  sellerReturnAddress: string | null;
  RequestedFunds: Array<{ amount: string; unit: string }>;
  SmartContractWallet: { walletVkey: string; walletAddress: string } | null;
  PaymentSource: { network: string; paymentSourceType: string; smartContractAddress: string };
  NextAction: { requestedAction: string; errorType: string | null; errorNote: string | null };
};

const DIRECT = new Set<PaymentState>(["FundsLocked", "ResultSubmitted", "RefundRequested", "Disputed", "Withdrawn", "RefundWithdrawn"]);

/** null = nothing locked on chain yet. States outside the contract's list collapse to "Other". */
export function toPaymentState(onChainState: string | null): PaymentState {
  if (onChainState === null) return "WaitingForPayment";
  return DIRECT.has(onChainState as PaymentState) ? (onChainState as PaymentState) : "Other";
}

function fromMs(field: string, value: string | null): Date {
  const ms = Number(value);
  if (value === null || !Number.isFinite(ms)) throw new MasumiApiError(502, "/payment", `${field} is not a unix-ms time: ${value}`);
  return new Date(ms);
}

function assertPreprodAddress(field: string, address: string): void {
  if (!address.startsWith("addr_test1")) throw new MasumiInputError(`${field} must be a preprod address (addr_test1…)`);
}

export async function createPaymentRequest(
  c: MasumiConfig,
  p: {
    agentIdentifier: string;
    inputHash: string;
    identifierFromPurchaser: string;
    submitResultTime: Date;
    payByTime: Date;
    sellerReturnAddress?: string;
  },
): Promise<{
  blockchainIdentifier: string;
  payByTime: Date;
  submitResultTime: Date;
  unlockTime: Date;
  externalDisputeUnlockTime: Date;
  sellerVKey: string;
}> {
  if (!AGENT_ID.test(p.agentIdentifier)) throw new MasumiInputError("agentIdentifier must be the registry asset id (hex)");
  if (!HEX64.test(p.inputHash)) throw new MasumiInputError("inputHash must be a 64-char hex sha256 (MIP-004)");
  if (!PURCHASER_ID.test(p.identifierFromPurchaser)) {
    throw new MasumiInputError("identifierFromPurchaser must be 14-26 hex characters");
  }
  const now = Date.now();
  const submit = p.submitResultTime.getTime();
  const payBy = p.payByTime.getTime();
  if (submit < now + MIN_SUBMIT_LEAD_MS) {
    throw new MasumiInputError(`submitResultTime must be at least ${MIN_SUBMIT_LEAD_MS / 60_000} minutes from now (node minimum: 15)`);
  }
  if (payBy <= now) throw new MasumiInputError("payByTime must be in the future");
  if (payBy > submit - MIN_PAYBY_GAP_MS) throw new MasumiInputError("payByTime must be at least 5 minutes before submitResultTime");
  if (p.sellerReturnAddress !== undefined) assertPreprodAddress("sellerReturnAddress", p.sellerReturnAddress);

  const unlock = submit + UNLOCK_AFTER_SUBMIT_MS;
  const dispute = unlock + DISPUTE_AFTER_UNLOCK_MS;
  const payment = await call<PaymentDto>(c.baseUrl, c.token, "POST", "/payment", {
    body: {
      network: c.network,
      agentIdentifier: p.agentIdentifier,
      inputHash: p.inputHash,
      identifierFromPurchaser: p.identifierFromPurchaser,
      paymentSourceType: PAYMENT_SOURCE_TYPE,
      supportedPaymentSourceIndex: SUPPORTED_PAYMENT_SOURCE_INDEX,
      payByTime: new Date(payBy).toISOString(),
      submitResultTime: new Date(submit).toISOString(),
      unlockTime: new Date(unlock).toISOString(),
      externalDisputeUnlockTime: new Date(dispute).toISOString(),
      ...(p.sellerReturnAddress !== undefined ? { sellerReturnAddress: p.sellerReturnAddress } : {}),
    },
  });
  if (!payment.SmartContractWallet) {
    throw new MasumiApiError(502, "/payment", "response has no SmartContractWallet (seller vkey)");
  }
  return {
    blockchainIdentifier: payment.blockchainIdentifier,
    payByTime: payment.payByTime === null ? new Date(payBy) : fromMs("payByTime", payment.payByTime),
    submitResultTime: fromMs("submitResultTime", payment.submitResultTime),
    unlockTime: fromMs("unlockTime", payment.unlockTime),
    externalDisputeUnlockTime: fromMs("externalDisputeUnlockTime", payment.externalDisputeUnlockTime),
    sellerVKey: payment.SmartContractWallet.walletVkey,
  };
}

export async function resolvePayment(c: MasumiConfig, blockchainIdentifier: string): Promise<PaymentDto> {
  return call<PaymentDto>(c.baseUrl, c.token, "POST", "/payment/resolve-blockchain-identifier", {
    body: { network: c.network, blockchainIdentifier },
  });
}

export async function getPaymentState(c: MasumiConfig, blockchainIdentifier: string): Promise<PaymentState> {
  return toPaymentState((await resolvePayment(c, blockchainIdentifier)).onChainState);
}

/** resultHash = MIP-004 output hash sha256(identifier + ";" + output): 64 hex, NOT inputHash+outputHash. */
export async function submitResult(c: MasumiConfig, blockchainIdentifier: string, resultHash: string): Promise<void> {
  if (!HEX64.test(resultHash)) {
    throw new MasumiInputError("resultHash must be the 64-char hex MIP-004 output hash (not inputHash+outputHash)");
  }
  await call<unknown>(c.baseUrl, c.token, "POST", "/payment/submit-result", {
    body: { network: c.network, blockchainIdentifier, submitResultHash: resultHash },
  });
}
