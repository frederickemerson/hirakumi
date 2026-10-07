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
  retired: "Retired",
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

/** The listing timeline, in order. The only names a seller ever sees for onboarding steps. */
export const TIMELINE_LABEL = {
  read: "Read your file",
  describe: "Describe endpoints",
  choose: "Choose endpoints",
  ownership: "Prove ownership",
  test: "Test calls",
  promise: "Write the promise",
  register: "Register on Masumi",
} as const;

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

/** One name for taking a live API off the market, everywhere: Retire. */
export const RETIRE_COPY = {
  trigger: "Retire",
  title: (name: string) => `Retire ${name}?`,
  description:
    "Retiring stops new sales and takes the API off the agent market. It stays in your account as Retired. This can't be undone.",
  confirm: "Retire API",
  pending: "Retiring…",
} as const;

export function cardanoscanTxUrl(txHash: string): string {
  return `https://preprod.cardanoscan.io/transaction/${encodeURIComponent(txHash)}`;
}

export function shortAddress(addr: string): string {
  return addr.length <= 20 ? addr : `${addr.slice(0, 12)}…${addr.slice(-6)}`;
}

/** "6 Oct 2026, 23:30 UTC". Always UTC and labelled, like the status page's hour bars (lib/status-labels hhmm). */
export function formatTime(d: Date | string): string {
  return `${new Date(d).toLocaleString("en-GB", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" })} UTC`;
}

/** "1 call", "2 calls". */
export function plural(n: number, noun: string, many = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : many}`;
}

/**
 * The API's base URL, origin + path_prefix, exactly as the gateway's ownership check requests it ("" and "/" give
 * origin + "/"). Only meaningful once the parse step has set both (state "parsed" on). Same as apiBaseUrl in
 * @hirakumi/core, kept here because client components import this file and core is server only.
 */
export function apiBaseUrl(api: { origin: string; pathPrefix: string }): string {
  return `${api.origin.replace(/\/+$/, "")}${api.pathPrefix === "" ? "/" : api.pathPrefix}`;
}
