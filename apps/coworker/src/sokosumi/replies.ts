/**
 * Structured parsing of the seller's text on a Sokosumi task: the OpenAPI link and the replies the coworker asked
 * for (`sell 1 2`, `price 2.5 for 100 calls`, `publish`). Nothing here guesses intent; anything else is "no command".
 */

export class LinkError extends Error {}

/**
 * The web's validateOpenApiUrl (apps/web/lib/validate.ts), same rules and wording, so a link the coworker accepts
 * is a link the setup page accepts. The fetch itself goes through @hirakumi/core safeFetch (SSRF-safe).
 */
export function validateOpenApiUrl(raw: unknown, allowInsecure: boolean): { url: string; origin: string; hostname: string } {
  if (typeof raw !== "string" || raw.trim() === "") throw new LinkError("Paste the link to your OpenAPI description.");
  const s = raw.trim();
  if (s.length > 2048) throw new LinkError("That link is too long.");
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new LinkError("That doesn't look like a web link. It should start with https://");
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(allowInsecure && u.protocol === "http:" && local)) {
    throw new LinkError("The link must start with https://");
  }
  if (u.username || u.password) {
    throw new LinkError("Remove the username and password from the link. Hirakumi only supports public API descriptions.");
  }
  u.hash = "";
  return { url: u.toString(), origin: u.origin, hostname: u.hostname };
}

/** Every http(s) link written in the text, in order, without trailing punctuation or markdown wrapping. */
export function findLinks(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'`()[\]{}|\\^]+/gi)) {
    const link = m[0].replace(/[.,;:!?*_~]+$/, "");
    if (!out.includes(link)) out.push(link);
  }
  return out;
}

export type Command =
  | { kind: "sell"; refs: string[]; readOnlyConfirmed: boolean }
  | { kind: "price"; priceText: string; calls: number | null }
  | { kind: "publish" };

const READ_ONLY = new Set(["readonly", "read-only", "read_only"]);

/** One reply → one command, or null. Backticks and a trailing period are allowed, since we quote the commands. */
export function parseCommand(text: string): Command | null {
  const s = text.replace(/`/g, " ").trim().replace(/\.$/, "").trim();
  if (/^publish$/i.test(s)) return { kind: "publish" };
  const sell = /^sell\s+(.+)$/i.exec(s);
  if (sell) {
    const words = sell[1].split(/[\s,]+/).filter((w) => w && !/^(and|&)$/i.test(w));
    const readOnlyConfirmed = words.some((w) => READ_ONLY.has(w.toLowerCase()));
    const refs = words.filter((w) => !READ_ONLY.has(w.toLowerCase()));
    if (refs.length === 0 || refs.length > 50 || refs.some((r) => !/^[A-Za-z0-9_.\-/{}]{1,120}$/.test(r))) return null;
    return { kind: "sell", refs: [...new Set(refs)], readOnlyConfirmed };
  }
  const price = /^price\s+(\d{1,9}(?:\.\d{1,6})?)(?:\s*t?usdm)?(?:\s+(?:for|per)\s+(\d{1,6})\s+calls?)?$/i.exec(s);
  if (price) return { kind: "price", priceText: price[1], calls: price[2] ? Number(price[2]) : null };
  return null;
}

/** How the coworker writes a command back ("I read your reply as `sell 1 2`"). */
export function formatCommand(c: Command): string {
  switch (c.kind) {
    case "publish": return "publish";
    case "sell": return `sell ${c.refs.join(" ")}${c.readOnlyConfirmed ? " readonly" : ""}`;
    case "price": return `price ${c.priceText}${c.calls ? ` for ${c.calls} calls` : ""}`;
  }
}

/** Mirrors apps/web/lib/money.ts. String arithmetic only: never parse money as a float. */
export const MIN_PRICE_MICROS = 1_000_000n;
export function tusdmToMicros(s: string): bigint {
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(s)) throw new Error(`not an amount: ${s}`);
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
}
export function formatTusdm(micros: string | bigint): string {
  const v = BigInt(micros);
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${v / 1_000_000n}.${frac}` : `${v / 1_000_000n}`;
}

/** The web review page's defaults (apps/web/components/review-panel.tsx): 100 calls for 2 tUSDM, 2 tUSDM per job. */
export const SUGGESTED_PACK = { calls: 100, priceMicros: 2_000_000n, escrowPriceMicros: 2_000_000n };
