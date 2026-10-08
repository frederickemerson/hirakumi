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

/**
 * A same-site path to go to after login, else "/apis". The browser's own URL parser decides: a value it resolves to
 * another origin (`//host`, `/\host`, or `/<tab>/host`, since parsers strip tabs and newlines) is refused.
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/")) return "/apis";
  const base = "https://same-site.invalid";
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return "/apis";
  }
  if (url.origin !== base) return "/apis";
  return url.pathname + url.search + url.hash;
}

const STALE_AFTER_MS = 10 * 60 * 1000;

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
