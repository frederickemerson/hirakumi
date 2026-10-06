/** The @hirakumi/masumi contract functions with MasumiConfig already bound (see masumi-live.ts, Task 15). */
export type PaymentState =
  | "WaitingForPayment" | "FundsLocked" | "ResultSubmitted" | "RefundRequested"
  | "Disputed" | "Withdrawn" | "RefundWithdrawn" | "Other";

export type PaymentRequestResult = {
  blockchainIdentifier: string; payByTime: Date; submitResultTime: Date; unlockTime: Date;
  externalDisputeUnlockTime: Date; sellerVKey: string;
};

export type MasumiPort = {
  createPaymentRequest(p: {
    agentIdentifier: string; inputHash: string; identifierFromPurchaser: string; submitResultTime: Date; payByTime: Date;
    /** Contract v1.1 M2: escrow collection goes straight to the seller's verified address. */
    sellerReturnAddress?: string;
  }): Promise<PaymentRequestResult>;
  getPaymentState(blockchainIdentifier: string): Promise<PaymentState>;
  submitResult(blockchainIdentifier: string, resultHash: string): Promise<void>;
};
