/** Client-safe: the progress events of "Buy a pack live" and a reader for their NDJSON stream. */

/** Phases the gateway streams while the demo wallet buys a pack (apps/gateway/src/demoBuy.ts BuyEvent). */
export type BuyEvent =
  | { phase: "paying"; packId: string; calls: number; priceMicros: string; wallet: string }
  /** settlement: PACK_MODE=hybrid only, what the 402 chose and why. */
  | { phase: "settling"; settlement?: { mode: "direct" | "escrow"; reasons: string[] } }
  | { phase: "settled"; txHash: string | null; credits: number; ms: number; recovered: boolean }
  | { phase: "ready"; txHash: string | null; credits: number; pending: boolean; boughtAt: string }
  | { phase: "failed"; message: string; spent: boolean };

function parseLine(line: string): BuyEvent | null {
  if (!line) return null;
  try {
    const e = JSON.parse(line) as BuyEvent;
    return e && typeof e.phase === "string" ? e : null;
  } catch {
    return null;
  }
}

/** Yields events as their lines arrive. Broken lines are skipped. */
export async function* readBuyEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<BuyEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const e = parseLine(buf.slice(0, nl).trim());
      buf = buf.slice(nl + 1);
      if (e) yield e;
    }
    if (done) break;
  }
  const e = parseLine(buf.trim());
  if (e) yield e;
}

export const cardanoscanTx = (txHash: string) => `https://preprod.cardanoscan.io/transaction/${txHash}`;
