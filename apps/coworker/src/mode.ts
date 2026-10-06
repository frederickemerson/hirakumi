import type { SokosumiCoworker } from "./sokosumi/client.js";

export type Mode = { kind: "sokosumi" } | { kind: "dashboard"; reason: string };

/** Sokosumi's own access gate: active, whitelisted, and holding the "tasks" capability. */
export function selectMode(me: SokosumiCoworker | null): Mode {
  if (!me) return { kind: "dashboard", reason: "SOKOSUMI_COWORKER_API_KEY is empty" };
  if (me.archivedAt) return { kind: "dashboard", reason: `coworker ${me.id} is archived` };
  if (!me.isWhitelisted) return { kind: "dashboard", reason: `coworker ${me.id} is not whitelisted yet` };
  if (!me.capabilities.includes("tasks")) return { kind: "dashboard", reason: `coworker ${me.id} lacks the "tasks" capability` };
  return { kind: "sokosumi" };
}
