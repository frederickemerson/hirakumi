import { TIMELINE_LABEL } from "./copy";
import { API_STATES, type ApiState, type OnboardStep, type OnboardStepStatus } from "./types";

/**
 * One fixed, ordered listing timeline for the seller. It is derived from two authoritative sources:
 * the API's state (which only moves forward through API_STATES) and the coworker's step rows
 * (parse, describe, qa, register). Seller actions (choose endpoints, prove ownership, publish) have
 * no step row; the state alone says whether they are done or waiting for the seller.
 */
export type TimelineKey = keyof typeof TIMELINE_LABEL;
export const TIMELINE_KEYS = Object.keys(TIMELINE_LABEL) as TimelineKey[];

export type TimelineProgress = { done: number; total: number };
export type TimelineItem = {
  key: TimelineKey;
  label: string;
  status: OnboardStepStatus;
  /** When the running item started, for the elapsed counter (ISO). */
  since: string | null;
  /** Live sub-progress (test calls only). */
  progress: TimelineProgress | null;
};
export type Timeline = { items: TimelineItem[]; done: number; total: number; pct: number; current: TimelineItem | null };

type StepRow = Pick<OnboardStep, "step" | "status" | "output" | "updatedAt">;

const at = (s: ApiState) => API_STATES.indexOf(s);
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

function qaProgress(row: StepRow | undefined): (TimelineProgress & { startedAt: string | null }) | null {
  const p = (row?.output as { progress?: { done?: unknown; total?: unknown; startedAt?: unknown } } | null)?.progress;
  if (!p || typeof p.done !== "number" || typeof p.total !== "number" || p.total <= 0) return null;
  return { done: Math.min(p.done, p.total), total: p.total, startedAt: typeof p.startedAt === "string" ? p.startedAt : null };
}

/** A machine step that is the current one: failed if it failed for good, otherwise in progress (including retries). */
const machine = (row: StepRow | undefined): OnboardStepStatus => (row?.status === "failed" ? "failed" : "running");

export function buildTimeline(state: ApiState, steps: StepRow[]): Timeline {
  const row = (name: string) => steps.find((s) => s.step === name);
  const reached = (s: ApiState) => at(state) >= at(s);
  const parse = row("parse");
  const describe = row("describe");
  const qa = row("qa");
  const register = row("register");
  const progress = qaProgress(qa);
  const callsFinished = !!progress && progress.done >= progress.total;

  const status: Record<TimelineKey, OnboardStepStatus> = {
    read: reached("parsed") ? "done" : machine(parse),
    describe: reached("described") ? "done" : state === "parsed" ? machine(describe) : "pending",
    choose: reached("endpoints_confirmed") ? "done" : state === "described" ? "waiting_seller" : "pending",
    ownership: reached("ownership_verified") ? "done" : state === "endpoints_confirmed" ? "waiting_seller" : "pending",
    test: reached("rule_built") || (state === "ownership_verified" && callsFinished) ? "done" : state === "ownership_verified" ? machine(qa) : "pending",
    promise: reached("rule_built") ? "done" : state === "ownership_verified" && callsFinished ? machine(qa) : "pending",
    register: reached("live") ? "done" : state === "registering" ? machine(register) : reached("rule_built") ? "waiting_seller" : "pending",
  };
  const since: Partial<Record<TimelineKey, string | null>> = {
    read: iso(parse?.updatedAt),
    describe: iso(describe?.updatedAt),
    test: progress?.startedAt ?? iso(qa?.updatedAt),
    promise: iso(qa?.updatedAt),
    register: iso(register?.updatedAt),
  };

  const items: TimelineItem[] = TIMELINE_KEYS.map((key) => ({
    key,
    label: TIMELINE_LABEL[key],
    status: status[key],
    since: status[key] === "running" ? (since[key] ?? null) : null,
    progress: key === "test" && progress && status.test !== "pending" ? { done: progress.done, total: progress.total } : null,
  }));
  const done = items.filter((i) => i.status === "done").length;
  return {
    items,
    done,
    total: items.length,
    pct: Math.round((done / items.length) * 100),
    current: items.find((i) => i.status === "running" || i.status === "failed" || i.status === "waiting_seller") ?? null,
  };
}
