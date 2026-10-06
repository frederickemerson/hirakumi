/**
 * health_events.reasons (contract v1.1 D5) is an array of { op, reason, since }. Turns it into the
 * plain lines a seller reads: "getPrice: /price is missing". Plain strings pass through; anything else is dropped.
 */
export function formatHealthReasons(reasons: unknown): string[] {
  if (!Array.isArray(reasons)) return [];
  const out: string[] = [];
  for (const r of reasons) {
    let line: string | null = null;
    if (typeof r === "string") line = r;
    else if (r && typeof r === "object" && typeof (r as { reason?: unknown }).reason === "string") {
      const { op, reason } = r as { op?: unknown; reason: string };
      line = typeof op === "string" && op ? `${op}: ${reason}` : reason;
    }
    if (line && !out.includes(line)) out.push(line);
  }
  return out;
}
