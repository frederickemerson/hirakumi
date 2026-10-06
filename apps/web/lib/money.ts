export const MIN_PRICE_MICROS = 1_000_000n;

/**
 * Escrow packs pay the seller per call, so the pack price must split evenly across its calls in micro-tUSDM
 * (the gateway refuses to offer one that doesn't). Null when it does, else what to change, in the seller's words.
 */
export function unevenPackPrice(priceMicros: bigint, calls: number): string | null {
  if (calls < 1 || priceMicros % BigInt(calls) === 0n) return null;
  const n = BigInt(calls);
  const nearest = ((priceMicros + n - 1n) / n) * n; // the nearest even split at or above the price
  return `The pack price must split evenly across its ${calls} calls, because escrow pays you per call. Try ${formatTusdm(nearest)} tUSDM.`;
}
const MICROS = 1_000_000n;

export class MoneyError extends Error {}

/** "2.5" -> 2500000n. String arithmetic only: never parse money as a float. */
export function parseTusdm(input: string): bigint {
  const s = input.trim();
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(s)) {
    throw new MoneyError("Enter an amount like 2 or 2.50 (up to 6 decimal places).");
  }
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * MICROS + BigInt(frac.padEnd(6, "0"));
}

export function formatTusdm(micros: string | bigint): string {
  const value = BigInt(micros);
  const whole = value / MICROS;
  const frac = (value % MICROS).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function parsePackCalls(input: string): number {
  const s = input.trim();
  if (!/^\d{1,6}$/.test(s)) throw new MoneyError("Pack size must be a whole number of calls.");
  const n = Number(s);
  if (n < 1 || n > 100_000) throw new MoneyError("Pack size must be between 1 and 100,000 calls.");
  return n;
}

export function perCallTusdm(priceMicros: string | bigint, calls: number): string {
  return formatTusdm(BigInt(priceMicros) / BigInt(calls));
}
