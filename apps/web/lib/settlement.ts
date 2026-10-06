/** How a pack settles (gateway PACK_MODE and, in hybrid, the settlement policy). Client-safe. */
export type PackSettlement = { packId: string; mode: "direct" | "escrow"; reasons: string[]; recommended?: "direct" | "escrow" };

/** "Settlement: escrow, because: new seller". With escrow recommended but unavailable, says so. */
export function settlementLine(s: { mode: string; reasons: string[]; recommended?: string }): string {
  const because = s.reasons.length ? `, because: ${s.reasons.join(", ")}` : "";
  if (s.recommended && s.recommended !== s.mode) return `Settlement: ${s.mode} (${s.recommended} recommended${because})`;
  return `Settlement: ${s.mode}${because}`;
}
