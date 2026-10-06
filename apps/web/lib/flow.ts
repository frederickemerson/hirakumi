import type { ApiState, OnboardStep } from "./types";

export type Step = "endpoints" | "ownership" | "review" | "overview";

export function stepForState(state: ApiState): Step {
  switch (state) {
    case "intake":
    case "parsed":
    case "described":
      return "endpoints";
    case "endpoints_confirmed":
      return "ownership";
    case "ownership_verified":
    case "rule_built":
    case "priced":
      return "review";
    default:
      return "overview";
  }
}

export function safeNextPath(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/apis";
  return raw;
}

export const STALE_AFTER_MS = 10 * 60 * 1000;

export function isStale(checkedAt: Date | null, now: Date = new Date()): boolean {
  return !checkedAt || now.getTime() - checkedAt.getTime() > STALE_AFTER_MS;
}

export function firstFailedStep(steps: Pick<OnboardStep, "status" | "output">[]): string | null {
  const failed = steps.find((s) => s.status === "failed");
  if (!failed) return null;
  const output = failed.output as { error?: unknown } | null;
  if (output && typeof output.error === "string" && output.error.trim()) return output.error;
  return "Something went wrong while preparing your listing. Try pasting the link again.";
}
