export type MasumiConfig = {
  baseUrl: string;
  token: string;
  network: "Preprod";
  /** Masumi registry service (discovery). Needed only by getRegistryStatus / refreshRegistryStatus. */
  registryUrl?: string;
  registryToken?: string;
};

export type RegistryStatus = "Online" | "Offline" | "Deregistered" | "Invalid" | "Unknown";

export type PaymentState =
  | "WaitingForPayment"
  | "FundsLocked"
  | "ResultSubmitted"
  | "RefundRequested"
  | "Disputed"
  | "Withdrawn"
  | "RefundWithdrawn"
  | "Other";
