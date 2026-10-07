import {
  createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes,
} from "node:crypto";

/**
 * APIs that need a key. The seller gives a header (or query parameter) name and the key. The web app seals the key
 * to the gateway's public key (X25519 + HKDF-SHA256 + AES-256-GCM), so only the gateway can read it: the web app,
 * the coworker and the database never hold it in the clear, and it is never shown again. Where the key is sent is
 * bound in as associated data (upstreamSecretContext: the API's id, header or query, the name, the origin and the
 * path prefix), so a sealed key copied to another listing, moved to another header or parameter, or left behind
 * when the API's address changes does not open.
 *
 * The gateway adds the key to upstream requests only, and every upstream URL is already checked to be on the
 * proven origin and under the proven folder (urlWithinBase), and redirects are never followed.
 */
export type UpstreamAuthPlacement = "header" | "query";
/** One sealed key (hks2). `hint` is the last 4 characters, for the seller to recognise the key. */
export type StoredUpstreamSecret = { in: UpstreamAuthPlacement; name: string; sealed: string; hint: string };
/** Where one part of a sealed bag is sent. */
export type UpstreamPartPlacement = { in: UpstreamAuthPlacement; name: string };
/**
 * Several parts sealed together (hks3): where each goes, in order, and its hint (the last 4 characters of a secret
 * of 16 characters or more, else ""; always "" for fixed text). The values, which are fixed and the leak list are
 * inside `sealed`. `fixed: true` marks fixed text for display only: it is not in the AAD and nothing trusts it on open.
 */
export type StoredUpstreamBag = { v: 3; parts: (UpstreamPartPlacement & { hint: string; fixed?: true })[]; sealed: string };
/** What is stored in apis.upstream_auth: one key (hks2) or a bag of parts (hks3), told apart by isUpstreamBag. */
export type StoredUpstreamAuth = StoredUpstreamSecret | StoredUpstreamBag;
/** What the gateway uses after opening it. */
export type UpstreamCredential = { in: UpstreamAuthPlacement; name: string; value: string };
/** Where a sealed key may be sent: the API (apis.id), the placement and name, and the API's origin and path_prefix. */
export type UpstreamSecretContext = { apiId: string; in: UpstreamAuthPlacement; name: string; origin: string; pathPrefix: string };

/** True when the stored key is a bag of parts (hks3) rather than one key (hks2). */
export const isUpstreamBag = (stored: StoredUpstreamAuth): stored is StoredUpstreamBag =>
  (stored as { v?: unknown }).v === 3 || stored.sealed.startsWith(`${BAG_PREFIX}.`);

export class UpstreamAuthError extends Error {}
/** The key was sealed for another origin or path prefix: the seller must save it again. */
export class UpstreamAddressChangedError extends UpstreamAuthError {}

const SEALED_PREFIX = "hks2";
const INFO = Buffer.from("hirakumi upstream-auth v2");
const BAG_PREFIX = "hks3";
const BAG_INFO = Buffer.from("hirakumi upstream-auth v3");
export const MAX_UPSTREAM_SECRET_LENGTH = 4096;

// Headers the gateway sets itself, or that would change how the request is framed or routed.
const RESERVED_HEADERS = new Set([
  "accept", "user-agent", "content-type", "content-length", "host", "connection", "transfer-encoding", "te", "trailer",
  "upgrade", "keep-alive", "proxy-authorization", "proxy-connection", "expect", "x-hirakumi-probe", "forwarded",
  "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "accept-encoding",
]);

/** A new keypair: the public key goes to the web app, the private key to the gateway (base64 DER). */
export function generateUpstreamAuthKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
}

/** The public key (base64 DER) of a private key (base64 DER). Throws when the private key does not parse. */
export function publicKeyFromPrivate(privateKeyB64: string): string {
  const privateKey = createPrivateKey({ key: Buffer.from(privateKeyB64, "base64"), format: "der", type: "pkcs8" });
  return createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64");
}

/** The origin as URL.origin gives it, else as given. */
function canonicalOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    return origin.trim().replace(/\/+$/, "");
  }
}

/** The path prefix as the gateway joins it: no trailing slash, "" for the root. */
const canonicalPathPrefix = (p: string) => p.trim().replace(/\/+$/, "");

/**
 * The associated data a key is sealed with, versioned: a JSON array, so no field can run into the next.
 * Header names are compared lowercased (HTTP ignores their case); query names as typed.
 */
export function upstreamSecretContext(ctx: UpstreamSecretContext): string {
  const name = ctx.in === "header" ? ctx.name.trim().toLowerCase() : ctx.name.trim();
  return JSON.stringify([SEALED_PREFIX, ctx.apiId, ctx.in, name, canonicalOrigin(ctx.origin), canonicalPathPrefix(ctx.pathPrefix)]);
}

/** A short public tag of the address (origin and path prefix), so the gateway can say why a key no longer opens. */
function addressTag(ctx: { origin: string; pathPrefix: string }): string {
  const address = JSON.stringify([canonicalOrigin(ctx.origin), canonicalPathPrefix(ctx.pathPrefix)]);
  return createHash("sha256").update(address).digest().subarray(0, 12).toString("base64url");
}

function aesKey(shared: Buffer, ephemeralPub: Buffer, aad: Buffer, info: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, Buffer.concat([ephemeralPub, aad]), info, 32));
}

/** How one format seals: its prefix, its HKDF info, its associated data and its public address tag. */
type Envelope = { prefix: string; info: Buffer; aad: string; tag: string };

/** "<prefix>.<address tag>.<ephemeral key>.<iv>.<ciphertext>.<tag>", sealed to the public key with the envelope's AAD. */
function seal(publicKeyB64: string, env: Envelope, plaintext: string): string {
  const aad = Buffer.from(env.aad);
  const publicKey = createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" });
  const eph = generateKeyPairSync("x25519");
  const ephPub = eph.publicKey.export({ type: "spki", format: "der" });
  const key = aesKey(diffieHellman({ privateKey: eph.privateKey, publicKey }), ephPub, aad, env.info);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [env.prefix, env.tag, ephPub, iv, ct, cipher.getAuthTag()]
    .map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

/** The plaintext of seal(), or UpstreamAddressChangedError / UpstreamAuthError (see openUpstreamSecret). */
function open(privateKeyB64: string, env: Envelope, sealed: string): string {
  const parts = sealed.split(".");
  if (parts.length !== 6 || parts[0] !== env.prefix) throw new UpstreamAuthError("not a sealed upstream key");
  if (parts[1] !== env.tag) throw new UpstreamAddressChangedError("the API's address changed since the key was sealed");
  const aad = Buffer.from(env.aad);
  const [ephPub, iv, ct, tag] = parts.slice(2).map((p) => Buffer.from(p, "base64url"));
  try {
    const privateKey = createPrivateKey({ key: Buffer.from(privateKeyB64, "base64"), format: "der", type: "pkcs8" });
    const publicKey = createPublicKey({ key: ephPub, format: "der", type: "spki" });
    const decipher = createDecipheriv("aes-256-gcm", aesKey(diffieHellman({ privateKey, publicKey }), ephPub, aad, env.info), iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    throw new UpstreamAuthError("the upstream key could not be opened");
  }
}

const secretEnvelope = (ctx: UpstreamSecretContext): Envelope =>
  ({ prefix: SEALED_PREFIX, info: INFO, aad: upstreamSecretContext(ctx), tag: addressTag(ctx) });

/**
 * Seals a key for one API, placement, name and address. Only the holder of the private key can open it, and only
 * with the same context. The result is "hks2.<address tag>.<ephemeral key>.<iv>.<ciphertext>.<tag>".
 */
export function sealUpstreamSecret(publicKeyB64: string, ctx: UpstreamSecretContext, secret: string): string {
  return seal(publicKeyB64, secretEnvelope(ctx), secret);
}

/**
 * Opens a sealed key with the context it was sealed for. Throws UpstreamAddressChangedError when the API's origin
 * or path prefix changed since, and UpstreamAuthError when it is malformed, tampered with, or sealed for another
 * API, placement or name.
 */
export function openUpstreamSecret(privateKeyB64: string, ctx: UpstreamSecretContext, sealed: string): string {
  return open(privateKeyB64, secretEnvelope(ctx), sealed);
}

/**
 * A bag of 1-4 parts sealed together (hks3), for keys one header or parameter can't carry: the same key in two
 * headers, a key plus fixed text (a version header), a header plus a query key, HTTP Basic with a password.
 * `values[i]` is sent as `parts[i]`; `fixed` lists the indexes of fixed text (public, not looked for in answers);
 * `leak` is what the web app says must never reach a buyer (see validateUpstreamBag, which adds what it can derive).
 */
export type UpstreamBag = { values: string[]; fixed: number[]; leak: string[] };
/** Where a bag may be sent: the API, every part's placement and name in order, and the API's origin and path_prefix. */
export type UpstreamBagContext = { apiId: string; parts: UpstreamPartPlacement[]; origin: string; pathPrefix: string };
/** A bag's plaintext is at most this many bytes. */
export const MAX_UPSTREAM_BAG_BYTES = 8192;

/**
 * The associated data a bag is sealed with: the version, the API, each part's placement and name (header names
 * lowercased) in order, and the canonical origin and path prefix (as hks2), so a part moved, renamed, reordered,
 * added or removed does not open.
 */
export function upstreamBagContext(ctx: UpstreamBagContext): string {
  const parts = ctx.parts.map((p) => [p.in, p.in === "header" ? p.name.trim().toLowerCase() : p.name.trim()]);
  return JSON.stringify([BAG_PREFIX, ctx.apiId, parts, canonicalOrigin(ctx.origin), canonicalPathPrefix(ctx.pathPrefix)]);
}

const bagEnvelope = (ctx: UpstreamBagContext): Envelope =>
  ({ prefix: BAG_PREFIX, info: BAG_INFO, aad: upstreamBagContext(ctx), tag: addressTag(ctx) });

/** Seals a bag for one API, its parts' placements and names, and its address: "hks3.<address tag>.…". */
export function sealUpstreamBag(publicKeyB64: string, ctx: UpstreamBagContext, bag: UpstreamBag): string {
  const plaintext = JSON.stringify({ values: bag.values, fixed: bag.fixed, leak: bag.leak });
  if (Buffer.byteLength(plaintext) > MAX_UPSTREAM_BAG_BYTES) throw new UpstreamAuthError("The key's parts are too long together.");
  return seal(publicKeyB64, bagEnvelope(ctx), plaintext);
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * Opens a sealed bag with the context it was sealed for. Throws like openUpstreamSecret, and UpstreamAuthError when
 * the plaintext is not a bag. It checks the shape only: validateUpstreamBag checks the parts before they are used.
 */
export function openUpstreamBag(privateKeyB64: string, ctx: UpstreamBagContext, sealed: string): UpstreamBag {
  const plaintext = open(privateKeyB64, bagEnvelope(ctx), sealed);
  let bag: unknown;
  try {
    bag = Buffer.byteLength(plaintext) <= MAX_UPSTREAM_BAG_BYTES ? JSON.parse(plaintext) : null;
  } catch {
    bag = null;
  }
  const b = bag as Partial<UpstreamBag> | null;
  if (!b || !isStringArray(b.values) || !isStringArray(b.leak) || !Array.isArray(b.fixed) || !b.fixed.every((i) => Number.isInteger(i))) {
    throw new UpstreamAuthError("the upstream key could not be opened");
  }
  return { values: b.values, fixed: b.fixed, leak: b.leak };
}

/** Checks what the seller typed. Header names are tokens and not ones the gateway owns; values have no line breaks. */
export function validateUpstreamAuth(raw: { in: unknown; name: unknown; value: unknown }): UpstreamCredential {
  return validateUpstreamPart(raw);
}

/**
 * Checks one part of a key, by validateUpstreamAuth's rules: a header (a token the gateway does not own) or a query
 * parameter (not "body"), and a value of printable ASCII without line breaks, at most 4096 characters. A secret
 * needs 8 characters or more; fixed text (`fixed: true`, a version header say) needs one.
 */
export function validateUpstreamPart(raw: { in: unknown; name: unknown; value: unknown }, opts: { fixed?: boolean } = {}): UpstreamCredential {
  if (raw.in !== "header" && raw.in !== "query") throw new UpstreamAuthError("Choose whether the key goes in a header or a query parameter.");
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (raw.in === "header") {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) throw new UpstreamAuthError("The header name can only use letters, digits and '-', for example X-API-Key or Authorization.");
    if (RESERVED_HEADERS.has(name.toLowerCase())) throw new UpstreamAuthError(`Hirakumi sets the ${name} header itself. Use the header your API reads the key from.`);
  } else {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(name)) throw new UpstreamAuthError("The query parameter name can only use letters, digits, '_', '.' and '-', for example api_key.");
    if (name === "body") throw new UpstreamAuthError(`"body" is reserved for the request body.`);
  }
  const value = typeof raw.value === "string" ? raw.value.trim() : "";
  if (opts.fixed && value.length < 1) throw new UpstreamAuthError("Enter the fixed text, or remove that part.");
  if (!opts.fixed && value.length < 8) throw new UpstreamAuthError("That key looks too short. Paste the whole key.");
  if (value.length > MAX_UPSTREAM_SECRET_LENGTH) throw new UpstreamAuthError("That key is too long.");
  // Visible ASCII and spaces only: no line breaks (header injection) and no control characters.
  if (!/^[\x20-\x7e]+$/.test(value)) throw new UpstreamAuthError("The key can only contain printable characters, with no line breaks.");
  return { in: raw.in, name, value };
}

/** The last 4 characters, for display only. Short keys show nothing. */
export const upstreamSecretHint = (value: string) => (value.length >= 16 ? value.slice(-4) : "");

/** Shorter than this, a part of a key is not looked for on its own (it could match ordinary text). */
const MIN_SECRET_PART = 8;
/** The token after a scheme word ("Bearer abc1234") is looked for down to this length: it is the key itself. */
const MIN_SCHEME_TOKEN = 4;

/** "Basic <base64 of user:password>" decoded, or null. */
function basicCredentials(value: string): { pair: string; user: string; password: string } | null {
  const m = /^basic\s+([A-Za-z0-9+/_-]+=*)$/i.exec(value.trim());
  if (!m) return null;
  const pair = Buffer.from(m[1], "base64").toString("utf8");
  const colon = pair.indexOf(":");
  if (colon === -1 || !/^[\x20-\x7e]+$/.test(pair)) return null;
  return { pair, user: pair.slice(0, colon), password: pair.slice(colon + 1) };
}

/**
 * The parts of a key an upstream may repeat: the whole value, for "Bearer abc…", "Token abc…" or "Basic abc…" the
 * token after the scheme word (4 characters or more), for any value with spaces the part after the last space
 * (8 characters or more), and for "Basic <base64>" the decoded "user:password" and the user and password on their
 * own (4 characters or more).
 */
export function upstreamSecretParts(value: string): string[] {
  const parts = [value];
  const scheme = /^(?:bearer|token|basic|apikey|api-key|key)\s+(.+)$/i.exec(value);
  const token = scheme ? scheme[1].trim() : "";
  if (token.length >= MIN_SCHEME_TOKEN) parts.push(token);
  const last = value.trim().split(/\s+/).pop() ?? "";
  if (last.length >= MIN_SECRET_PART) parts.push(last);
  const basic = basicCredentials(value);
  if (basic) parts.push(...[basic.pair, basic.user, basic.password].filter((p) => p.length >= MIN_SCHEME_TOKEN));
  return [...new Set(parts)];
}

const base64Forms = (s: string) => {
  const b64 = Buffer.from(s, "utf8").toString("base64");
  return [b64, b64.replace(/=+$/, ""), Buffer.from(s, "utf8").toString("base64url")];
};
/**
 * The part as an upstream may have read it: a "+" in a query value decoded as a space (form encoding), and its bytes
 * hex encoded, as UTF-8 and as UTF-16LE and UTF-16BE (only for parts of MIN_SECRET_PART characters or more, so a
 * short token's hex does not match ordinary digits). Matching ignores case, so the hex forms also stand for upper
 * case hex.
 */
const readForms = (s: string) => [
  ...(s.includes("+") ? [s.replaceAll("+", " ")] : []),
  ...(s.length >= MIN_SECRET_PART
    ? [Buffer.from(s, "utf8").toString("hex"), Buffer.from(s, "utf16le").toString("hex"), Buffer.from(s, "utf16le").swap16().toString("hex")]
    : []),
];
const htmlEscape = (s: string, quot: string, apos: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', quot).replaceAll("'", apos);

/**
 * The common ways the key (or one of its parts) is written in an answer or a message, found as they are so
 * redaction can replace them: as is, base64/base64url encoded, hex encoded and with "+" read as a space (readForms),
 * each of those as is, percent-encoded
 * (encodeURIComponent, or the form encoding URLSearchParams uses for the query), JSON-escaped (also with "\/", and
 * Go-style with & < > as \u0026 \u003c \u003e) and HTML/XML entity-escaped. Matching ignores case
 * (textLeaksSecret, redactUpstreamSecret), so a form stands for every casing of it. Longest first, so redaction
 * never leaves part of a longer form behind. Other encodings are found by normalising the text (textLeaksSecret).
 */
export function upstreamSecretForms(value: string): string[] {
  return partForms(upstreamSecretParts(value));
}

/** upstreamSecretForms of parts taken as they are (no heuristic split of each part). */
function partForms(parts: readonly string[]): string[] {
  const forms = parts.flatMap((part) => [part, ...base64Forms(part), ...readForms(part)]).flatMap((text) => {
    const json = JSON.stringify(text).slice(1, -1);
    const goJson = json.replaceAll("&", "\\u0026").replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
    return [
      text, json, json.replaceAll("/", "\\/"), goJson, goJson.replaceAll("/", "\\/"),
      encodeURIComponent(text), new URLSearchParams({ k: text }).toString().slice(2),
      htmlEscape(text, "&quot;", "&#39;"), htmlEscape(text, "&quot;", "&#x27;"), htmlEscape(text, "&#34;", "&apos;"),
    ];
  });
  return [...new Set(forms.map((f) => f.toLowerCase()))].filter((f) => f !== "").sort((a, b) => b.length - a.length);
}

/** The parts, their base64 forms and readForms, lowercased: what is looked for in normalised and base64-decoded text. */
const plainNeedles = (parts: readonly string[]) =>
  [...new Set(parts.flatMap((p) => [p, ...base64Forms(p), ...readForms(p)]).map((f) => f.toLowerCase()))].filter(Boolean);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", plus: "+", sol: "/", equals: "=", colon: ":", num: "#", percnt: "%",
  lowbar: "_", hyphen: "-", dash: "-", period: ".", comma: ",", excl: "!", quest: "?", lpar: "(", rpar: ")", ast: "*",
  commat: "@", dollar: "$", semi: ";", tilde: "~", verbar: "|", bsol: "\\", lsqb: "[", rsqb: "]", lcub: "{", rcub: "}",
  nbsp: " ", shy: "\u00ad", zwnj: "\u200c", zwj: "\u200d", nobreak: "\u2060",
};
const codePoint = (n: number, whole: string) => (n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole);

const JSON_CONTROL: Record<string, string> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/** Characters that show as nothing: zero-width space, non-joiner and joiner, word joiner, BOM, and the soft hyphen. */
const INVISIBLE = /[\u00ad\u200b-\u200d\u2060\ufeff]/g;

/**
 * One round of unescaping: JSON backslash escapes (\uXXXX, \/ \" \\, \n and the like), \xXX, HTML entities (named,
 * decimal, hex), and %XX for ASCII. Invisible characters (INVISIBLE), written as they are or escaped, are removed.
 */
function decodeOnce(t: string): string {
  return t
    // Backslash escapes in one left-to-right pass, like a JSON parser: the raw text \\u0073 (a \u escape escaped
    // once more) is the escape \\ then "u0073", so it reads \u0073 here and "s" in the next round. One pass per escape
    // kind read it as "\" + "\u0073" and lost the key. \n, \t and the like become their characters, so a base64 token
    // after them starts where it really starts.
    .replace(/\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([/"'\\])|([bfnrt]))/g, (w, u?: string, x?: string, c?: string, ctl?: string) =>
      c ?? (ctl ? JSON_CONTROL[ctl]! : codePoint(parseInt((u ?? x)!, 16), w)))
    .replace(/&#(\d{1,7});?/g, (w, d: string) => codePoint(parseInt(d, 10), w))
    .replace(/&#[xX]([0-9a-fA-F]{1,6});?/g, (w, h: string) => codePoint(parseInt(h, 16), w))
    .replace(/&([A-Za-z]{2,8});/g, (w, n: string) => NAMED_ENTITIES[n.toLowerCase()] ?? w)
    .replace(/%([0-7][0-9a-fA-F])/g, (_w, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(INVISIBLE, "");
}

/** Rounds of decoding before normaliseText stops: enough for any encoding a real upstream nests, and bounded. */
const MAX_DECODE_ROUNDS = 8;

/** The text with common escapes undone, repeated until it stops changing (at most MAX_DECODE_ROUNDS rounds). */
function normaliseText(text: string): string {
  let t = text;
  for (let i = 0; i < MAX_DECODE_ROUNDS; i++) {
    const next = decodeOnce(t);
    if (next === t) break;
    t = next;
  }
  return t;
}

const BASE64_TOKEN = /[A-Za-z0-9+/_-]{16,}={0,2}/g;
/**
 * Base64 broken over lines, as MIME (76 columns, CRLF) and PEM (64, LF) write it: runs of base64 characters joined
 * by one line break each, with spaces or tabs around it. Starting only at the start of a run and one break per joint
 * keep the match linear in the text's length.
 */
const WRAPPED_BASE64 = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]+(?:[ \t]*(?:\r\n|\r|\n)[ \t]*[A-Za-z0-9+/_-]+)+={0,2}/g;

/** The text with each line-wrapped base64 run joined into one token, or null when it has none. */
function unwrapBase64(text: string): string | null {
  const joined = text.replace(WRAPPED_BASE64, (m) => m.replace(/\s+/g, ""));
  return joined === text ? null : joined;
}
const MAX_BASE64_TOKENS = 200;
const MAX_BASE64_TOKEN_LENGTH = 4096;

/**
 * The decoded base64/base64url tokens of 16 characters or more in the texts (at most 200, each up to 4 KB), each as
 * decoded and normalised. As decoded too, because normalising can eat the key's first characters ("%" then a key
 * starting "0A" reads as a line break).
 */
function decodedBase64Tokens(texts: string[]): string[] {
  const out: string[] = [];
  let tokens = 0;
  for (const text of texts) {
    for (const m of text.matchAll(BASE64_TOKEN)) {
      if (tokens++ >= MAX_BASE64_TOKENS) return out;
      const decoded = Buffer.from(m[0].slice(0, MAX_BASE64_TOKEN_LENGTH), "base64").toString("latin1");
      out.push(decoded, normaliseText(decoded));
    }
  }
  return out;
}

/**
 * True when text contains the key (or one of its parts), in any case. It looks for the forms of
 * upstreamSecretForms as they are, then in the text with escapes undone (mixed percent-encoding, \u00XX escapes of
 * every character as ASP.NET writes them, decimal and hex HTML entities) and zero-width characters and soft hyphens
 * removed, then inside base64 and base64url tokens of the answer, line-wrapped ones (MIME, PEM) joined first. This is
 * defence in depth, not a complete check: it catches common encodings, not every one (not the key reversed, nor
 * base64 encoded three times). An upstream can always transform the key in a way no check foresees, so sending the
 * key in a header (which answers echo less often than URLs) is the safer default.
 */
export function textLeaksSecret(text: string | null | undefined, value: string): boolean {
  return textLeaksAny(text, upstreamSecretParts(value));
}

/**
 * The needles that contain no other needle: text holding a longer one holds the shorter one too ("bearer k" holds
 * "k", and so do their hex and escaped forms), so looking for these alone finds exactly the same texts, faster.
 */
function shortestNeedles(needles: readonly string[]): string[] {
  const kept: string[] = [];
  for (const n of [...needles].sort((a, b) => a.length - b.length)) if (!kept.some((k) => n.includes(k))) kept.push(n);
  return kept;
}

/**
 * True when text contains any of the parts, as textLeaksSecret checks one key, but with the parts taken as they are
 * (a sealed bag's leakParts: no user of a Basic pair is guessed). The text is decoded once, whatever the number of
 * parts, and every part's forms are looked for in one pass over each decoded text.
 */
export function textLeaksAny(text: string | null | undefined, parts: readonly string[]): boolean {
  if (!text || parts.length === 0) return false;
  const lower = text.toLowerCase();
  if (shortestNeedles(partForms(parts)).some((f) => lower.includes(f))) return true;
  const plain = plainNeedles(parts);
  const needles = shortestNeedles(plain);
  const normalised = [normaliseText(text)];
  if (plain.some((n) => n.includes(" "))) normalised.push(normaliseText(text.replaceAll("+", " ")));
  const found = (t: string) => {
    const l = t.toLowerCase();
    return needles.some((n) => l.includes(n));
  };
  // A text already scanned is not scanned again: the needles are a subset of partForms, so text that normalising
  // left as it was has been looked at above. Every text still gives its base64 tokens, in order, as before.
  if (normalised.some((t, i) => t !== text && t !== normalised[i - 1] && found(t))) return true;
  const scanned = [text, ...normalised];
  const unwrapped: (string | null)[] = [];
  scanned.forEach((t, i) => unwrapped.push(i > 0 && t === scanned[i - 1] ? (unwrapped[i - 1] ?? null) : unwrapBase64(t)));
  return decodedBase64Tokens([...scanned, ...unwrapped.filter((t): t is string => t !== null)]).some(found);
}

/** True when any of the texts contains the key, by the same check as textLeaksSecret (example requests, say). */
export function keyAppearsIn(value: string, texts: readonly (string | null | undefined)[]): boolean {
  const parts = upstreamSecretParts(value);
  return texts.some((t) => textLeaksAny(t, parts));
}

/** What redactUpstreamSecret returns when the key is in the text but only after decoding, so it can't be cut out. */
export const WITHHELD_TEXT = "This text was withheld because it contained the API's key.";

/**
 * Replaces every form of the key it can locate (upstreamSecretForms, any case) with "[key]". When the key is still
 * there after that (only found once the text is decoded), the whole text is replaced with WITHHELD_TEXT.
 */
export function redactUpstreamSecret(text: string, value: string): string {
  return redactUpstreamParts(text, upstreamSecretParts(value));
}

/** redactUpstreamSecret for several parts taken as they are (a sealed bag's leakParts), longest form first. */
export function redactUpstreamParts(text: string, parts: readonly string[]): string {
  if (parts.length === 0) return text;
  const alternatives = partForms(parts).map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const redacted = text.replace(new RegExp(alternatives.join("|"), "gi"), "[key]");
  return textLeaksAny(redacted, parts) ? WITHHELD_TEXT : redacted;
}

/** What a bag opens to, checked: the parts to send, in order, and every text that must never reach a buyer. */
export type UpstreamAuth = { parts: UpstreamCredential[]; leakParts: string[] };
export const MAX_UPSTREAM_PARTS = 4;
/** At most this many leak entries in a bag, each 8 to 4096 characters. */
export const MAX_UPSTREAM_LEAK_ENTRIES = 8;
/** At most this many distinct forms of a bag's leakParts are looked for in an answer, so a bag can't make checks slow. */
export const MAX_UPSTREAM_LEAK_NEEDLES = 160;

/**
 * What the gateway derives from a secret value itself, so a leak list that leaves it out still covers it: for
 * "Basic <base64>" the password and "user:password"; for any other value with a word before the key ("Bearer K",
 * "SSWS K", "DeepL-Auth-Key K") the K, and the part after the last space; each when 8 characters or more. Never a
 * Basic user name: it is often public.
 */
function derivedSecrets(value: string): string[] {
  const basic = basicCredentials(value);
  if (basic) return [basic.password, basic.pair].filter((s) => s.length >= MIN_SECRET_PART);
  const token = /^\S+\s+(.+)$/.exec(value.trim())?.[1].trim() ?? "";
  const last = value.trim().split(/\s+/).pop() ?? "";
  return [token, last].filter((s) => s !== value && s.length >= MIN_SECRET_PART);
}

/**
 * The secret a value carries is too short to look for on its own: the key after a word ("Bearer abcd") or a Basic
 * password under 8 characters. The bearer and basic presets refuse these, and so do rows.
 */
export function schemeSecretTooShort(value: string): boolean {
  const basic = basicCredentials(value);
  if (basic) return basic.password.length < MIN_SECRET_PART;
  const token = /^\S+\s+(.+)$/.exec(value.trim())?.[1].trim();
  return token !== undefined && token.length < MIN_SECRET_PART;
}

/**
 * Checks an opened bag against where its parts go (both are untrusted: the web app runs the same check before
 * sealing). 1 to 4 parts, each valid (validateUpstreamPart; fixed text needs 1 character), header names unique in
 * any case and query names unique as typed, at least one secret part, and at most 8 leak entries of 8 to 4096
 * characters. leakParts is the leak list, every secret value, and what derivedSecrets finds in them; more than
 * MAX_UPSTREAM_LEAK_NEEDLES forms of them is refused. Throws UpstreamAuthError.
 */
export function validateUpstreamBag(placements: readonly UpstreamPartPlacement[], bag: UpstreamBag): UpstreamAuth {
  const n = placements.length;
  if (n < 1 || n > MAX_UPSTREAM_PARTS || bag.values.length !== n) throw new UpstreamAuthError(`A key can have 1 to ${MAX_UPSTREAM_PARTS} parts.`);
  if (!bag.fixed.every((i) => Number.isInteger(i) && i >= 0 && i < n)) throw new UpstreamAuthError("The key's parts don't match.");
  const fixed = new Set(bag.fixed);
  const parts = placements.map((p, i) => validateUpstreamPart({ in: p.in, name: p.name, value: bag.values[i] }, { fixed: fixed.has(i) }));
  const unique = (names: string[]) => new Set(names).size === names.length;
  if (!unique(parts.filter((p) => p.in === "header").map((p) => p.name.toLowerCase()))) throw new UpstreamAuthError("Each header can be used once.");
  if (!unique(parts.filter((p) => p.in === "query").map((p) => p.name))) throw new UpstreamAuthError("Each query parameter can be used once.");
  const secrets = parts.filter((_, i) => !fixed.has(i)).map((p) => p.value);
  if (secrets.length === 0) throw new UpstreamAuthError("At least one part must be the secret key, not fixed text.");
  if (bag.leak.length > MAX_UPSTREAM_LEAK_ENTRIES) throw new UpstreamAuthError("The key has too many secret parts.");
  if (bag.leak.some((l) => l.length < MIN_SECRET_PART || l.length > MAX_UPSTREAM_SECRET_LENGTH)) {
    throw new UpstreamAuthError("Each secret must be 8 to 4096 characters.");
  }
  const leakParts = [...new Set([...bag.leak, ...secrets, ...secrets.flatMap(derivedSecrets)])];
  if (new Set([...partForms(leakParts), ...plainNeedles(leakParts)]).size > MAX_UPSTREAM_LEAK_NEEDLES) {
    throw new UpstreamAuthError("The key's parts are too long or unusual for answers to be checked for them.");
  }
  return { parts, leakParts };
}

/** True when an upstream answer contains the key (or one of its parts), which must then not be passed on to a buyer. */
export function answerLeaksSecret(body: string, credential: UpstreamCredential | null | undefined): boolean {
  if (!credential) return false;
  return textLeaksSecret(body, credential.value);
}
