import type { ApiState, Health, OnboardStepStatus } from "./types";

export const STATE_LABEL: Record<ApiState, string> = {
  intake: "Reading your API description",
  parsed: "Describing your endpoints",
  described: "Waiting for you to choose endpoints",
  endpoints_confirmed: "Waiting for you to prove ownership",
  ownership_verified: "Running test calls",
  rule_built: "Waiting for you to set a price",
  priced: "Ready to publish",
  registering: "Registering on the Masumi network",
  live: "Live",
  retired: "Removed from the market",
};

export function healthLabel(h: Health): "Live" | "Down" {
  return h === "healthy" ? "Live" : "Down";
}

export const STEP_STATUS_LABEL: Record<OnboardStepStatus, string> = {
  pending: "Waiting",
  running: "In progress",
  done: "Done",
  failed: "Failed",
  waiting_seller: "Waiting for you",
};

export const PACK_STATUS_LABEL = {
  pending: "Waiting for the payment to settle",
  active: "Paid, credits available",
  exhausted: "Paid, all credits used",
  revoked: "Paid, access revoked",
} as const;

export const JOB_STATUS_LABEL = {
  awaiting_payment: "Waiting for the buyer's payment",
  running: "Running",
  completed: "Passed, result submitted",
  failed: "Didn't pass, Masumi refunds the buyer automatically",
  expired: "Expired, the buyer never paid",
} as const;

export function cardanoscanTxUrl(txHash: string): string {
  return `https://preprod.cardanoscan.io/transaction/${encodeURIComponent(txHash)}`;
}

export function shortAddress(addr: string): string {
  return addr.length <= 20 ? addr : `${addr.slice(0, 12)}…${addr.slice(-6)}`;
}

export function humanizeStep(step: string): string {
  const words = step.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function formatTime(d: Date | string): string {
  return new Date(d).toLocaleString("en-GB", { timeZone: "Asia/Singapore", dateStyle: "medium", timeStyle: "short" });
}
