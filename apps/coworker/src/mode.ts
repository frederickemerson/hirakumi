import type { SokosumiCoworker } from "./sokosumi/client.js";

export type Mode = { kind: "sokosumi" } | { kind: "dashboard"; reason: string };

/**
 * Sokosumi mode needs an active coworker with the "tasks" capability. Whitelisting is not required: it only
 * controls marketplace listing; task events and comments work without it (verified live on preprod).
 */
export function selectMode(me: SokosumiCoworker | null): Mode {
  if (!me) return { kind: "dashboard", reason: "SOKOSUMI_COWORKER_API_KEY is empty" };
  if (me.archivedAt) return { kind: "dashboard", reason: `coworker ${me.id} is archived` };
  if (!me.capabilities.includes("tasks")) return { kind: "dashboard", reason: `coworker ${me.id} lacks the "tasks" capability` };
  return { kind: "sokosumi" };
}
