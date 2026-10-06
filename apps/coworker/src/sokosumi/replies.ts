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
  // "api.example.com." names the same host but is a different origin and listing base: one spelling only.
  if (u.hostname.endsWith(".")) throw new LinkError("Remove the dot at the end of the host name in the link.");
  // The link is stored and read again at each parse, so it must be one plain file path, the same spelling every time.
  if (u.search !== "") throw new LinkError("Remove the ?query from the link. Use the plain path to your OpenAPI file.");
  if (u.hash !== "") throw new LinkError("Remove the #fragment from the link. Use the plain path to your OpenAPI file.");
  u.search = "";
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

/**
 * One reply → one command, or null. Backticks and a trailing period are allowed, since we quote the commands.
 * The command is the first line; lines under it are notes ("price 2", then why).
 */
export function parseCommand(text: string): Command | null {
  const first = text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  const s = first.replace(/`/g, " ").trim().replace(/\.$/, "").trim();
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

/**
 * Any API without an OpenAPI file: a base URL plus example requests, one per line ("GET /price?symbol=ADA" or
 * "/price?symbol=ADA"), the format of the setup page's "I don't" mode (@hirakumi/core samples.ts). Markdown list
 * markers and backticks around a line are dropped.
 */
const SAMPLE_LINE = /^(?:(?:GET|POST|PUT|PATCH|DELETE)\s+)?\/(?!\/)\S*/i;

function cleanLine(line: string): string {
  return line.trim().replace(/^(?:[-*•]|\d{1,2}[.)])\s+/, "").replace(/^`+|`+$/g, "").trim();
}

export function findSampleLines(text: string): string[] {
  return text.split(/\r?\n/).map(cleanLine).filter((l) => SAMPLE_LINE.test(l));
}

/** A link that names an OpenAPI or Swagger file rather than an API's base URL. */
export function looksLikeOpenApiLink(link: string): boolean {
  try {
    const path = new URL(link).pathname.toLowerCase();
    return /\.(json|ya?ml)$/.test(path) || /openapi|swagger|api-docs/.test(path);
  } catch {
    return false;
  }
}

// Hosts that serve files, never an API: a link there is an OpenAPI file even without .json or .yaml.
const FILE_HOSTS = new Set(["raw.githubusercontent.com", "gist.githubusercontent.com", "gist.github.com", "github.com", "gitlab.com", "bitbucket.org", "pastebin.com"]);
// A last path segment that names a description document (…/v1/spec, …/schema).
const SPEC_SEGMENT = /\/(?:spec|specs|schema|definition|description)(?:\/)?$/i;
// The seller calls the link a spec ("My spec:", "OpenAPI here"), but not "no OpenAPI file" or "without a spec".
const SPEC_WORD = /\b(?:spec|specification|openapi|swagger)\b/i;
const NO_SPEC = /\b(?:no|without|don'?t have|do not have|haven'?t got|not have)\b[^.\n]{0,24}\b(?:spec|specification|openapi|swagger)\b/i;

/** A link that can only be an OpenAPI file: by name, by file host, or by a last segment such as /spec. */
function surelySpecLink(link: string): boolean {
  if (looksLikeOpenApiLink(link)) return true;
  try {
    const u = new URL(link);
    return FILE_HOSTS.has(u.hostname.toLowerCase()) || SPEC_SEGMENT.test(u.pathname);
  } catch {
    return false;
  }
}

/** A line that carries example data (?query, {name=value} or a body), which an endpoint list in a spec message has not. */
const carriesRequestData = (line: string) => /\?|\{[^}]*=|\s[[{"]/.test(line);

// The words just before a link that name it as the API's address: "Base URL: https://…", "API: https://…", "base https://…".
const BASE_LABEL = /\b(?:base(?:\s*url)?|api|url|endpoint|server|host)\s*[:=]?\s*$/i;
// The words before a link that name it as documentation: "Docs: https://…", "see https://…".
const DOCS_LABEL = /\b(?:docs?|documentation|guide|readme|reference|see)\b/i;
// Hosts and paths that serve documentation or code, never the API itself.
const DOCS_HOST = /^(?:docs?|documentation|help|support|wiki|guides?|readme|blog)\.|\.(?:readme\.io|gitbook\.io|notion\.site|stoplight\.io|apiary\.io)$/i;
const DOCS_PATH = /^\/(?:docs?|documentation|guides?|reference)(?:\/|$)/i;

function docsHost(link: string): boolean {
  try {
    const u = new URL(link);
    const host = u.hostname.toLowerCase();
    return DOCS_HOST.test(host) || FILE_HOSTS.has(host) || DOCS_PATH.test(u.pathname);
  } catch {
    return false;
  }
}

/** Each link outside the example lines, with what its lines say about it. A link inside an example line is example data. */
function baseCandidates(text: string): { link: string; labelled: boolean; docs: boolean; alone: boolean }[] {
  const out = new Map<string, { link: string; labelled: boolean; docs: boolean; alone: boolean }>();
  for (const raw of text.split(/\r?\n/)) {
    const line = cleanLine(raw);
    if (SAMPLE_LINE.test(line)) continue;
    for (const link of findLinks(line)) {
      const before = line.slice(0, line.indexOf(link));
      const c = out.get(link) ?? { link, labelled: false, docs: docsHost(link), alone: false };
      c.labelled ||= BASE_LABEL.test(before);
      c.docs ||= DOCS_LABEL.test(before);
      c.alone ||= line.replace(/[.,;:!?*_~]+$/, "") === link;
      out.set(link, c);
    }
  }
  return [...out.values()];
}

/**
 * Which link is the base URL: the one on a line labelled base, API or URL; else the only one that isn't
 * documentation; else the only one on a line of its own. Several left: the seller is asked (choices).
 */
function chooseBase(text: string): { base: string } | { choices: string[] } | null {
  const all = baseCandidates(text);
  if (all.length <= 1) return all[0] ? { base: all[0].link } : null;
  const labelled = all.filter((c) => c.labelled && !c.docs);
  if (labelled.length === 1) return { base: labelled[0].link };
  if (labelled.length > 1) return { choices: labelled.map((c) => c.link) };
  const apis = all.filter((c) => !c.docs);
  if (apis.length === 1) return { base: apis[0].link };
  const alone = apis.filter((c) => c.alone);
  if (alone.length === 1) return { base: alone[0].link };
  return { choices: (apis.length ? apis : all).map((c) => c.link) };
}

/** A samples intake: the base URL, or the links the seller must choose from when it isn't clear which one it is. */
export type SamplesIntake = { base: string; lines: string } | { choices: string[]; lines: string };

/**
 * A samples intake: example request lines and a base URL, and no link that may be an OpenAPI file. null otherwise,
 * so a message with an OpenAPI link works exactly as before, even with endpoint paths listed next to it.
 * Plain paths ("GET /pets") next to a link the seller calls a spec are read as a spec link too.
 */
export function findSamplesIntake(text: string): SamplesIntake | null {
  const lines = findSampleLines(text);
  if (lines.length === 0) return null;
  const candidates = baseCandidates(text);
  if (candidates.length === 0 || candidates.some((c) => surelySpecLink(c.link))) return null;
  if (!lines.some(carriesRequestData) && SPEC_WORD.test(text) && !NO_SPEC.test(text)) return null;
  const base = chooseBase(text);
  if (!base) return null;
  return { ...base, lines: lines.join("\n") };
}

/**
 * Nothing but links and example request lines: clearly a samples intake, even on a task whose API is under way
 * (where a reply such as "price 2" with a note under it is a command).
 */
export function isOnlySamples(text: string): boolean {
  const lines = text.split(/\r?\n/).map(cleanLine).filter(Boolean);
  return lines.length > 0 && lines.every((l) => SAMPLE_LINE.test(l) || findLinks(l).length > 0);
}

/**
 * True when a comment seems to hold a key, token or password. The coworker then neither stores nor repeats it, and
 * points the seller at the ownership page, where the key is sealed so only the gateway can read it. Shared with the
 * web setup form's example requests (@hirakumi/core secrets.ts).
 */
export { looksLikeSecret } from "@hirakumi/core";
