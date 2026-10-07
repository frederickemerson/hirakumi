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
/** What is stored in apis.upstream_auth. `hint` is the last 4 characters, for the seller to recognise the key. */
export type StoredUpstreamAuth = { in: UpstreamAuthPlacement; name: string; sealed: string; hint: string };
/** What the gateway uses after opening it. */
export type UpstreamCredential = { in: UpstreamAuthPlacement; name: string; value: string };
/** Where a sealed key may be sent: the API (apis.id), the placement and name, and the API's origin and path_prefix. */
export type UpstreamSecretContext = { apiId: string; in: UpstreamAuthPlacement; name: string; origin: string; pathPrefix: string };

export class UpstreamAuthError extends Error {}
/** The key was sealed for another origin or path prefix: the seller must save it again. */
export class UpstreamAddressChangedError extends UpstreamAuthError {}

const SEALED_PREFIX = "hks2";
const INFO = Buffer.from("hirakumi upstream-auth v2");
export const MAX_UPSTREAM_SECRET_LENGTH = 4096;

// Headers the gateway sets itself, or that would change how the request is framed or routed.
const RESERVED_HEADERS = new Set([
  "accept", "user-agent", "content-type", "content-length", "host", "connection", "transfer-encoding", "te", "trailer",
  "upgrade", "keep-alive", "proxy-authorization", "proxy-connection", "expect", "x-hirakumi-probe", "forwarded",
  "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip",
]);

/** A new keypair: the public key goes to the web app, the private key to the gateway (base64 DER). */
export function generateUpstreamAuthKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
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
function addressTag(ctx: UpstreamSecretContext): string {
  const address = JSON.stringify([canonicalOrigin(ctx.origin), canonicalPathPrefix(ctx.pathPrefix)]);
  return createHash("sha256").update(address).digest().subarray(0, 12).toString("base64url");
}

function aesKey(shared: Buffer, ephemeralPub: Buffer, aad: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, Buffer.concat([ephemeralPub, aad]), INFO, 32));
}

/**
 * Seals a key for one API, placement, name and address. Only the holder of the private key can open it, and only
 * with the same context. The result is "hks2.<address tag>.<ephemeral key>.<iv>.<ciphertext>.<tag>".
 */
export function sealUpstreamSecret(publicKeyB64: string, ctx: UpstreamSecretContext, secret: string): string {
  const aad = Buffer.from(upstreamSecretContext(ctx));
  const publicKey = createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" });
  const eph = generateKeyPairSync("x25519");
  const ephPub = eph.publicKey.export({ type: "spki", format: "der" });
  const key = aesKey(diffieHellman({ privateKey: eph.privateKey, publicKey }), ephPub, aad);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [SEALED_PREFIX, addressTag(ctx), ephPub, iv, ct, cipher.getAuthTag()]
    .map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

/**
 * Opens a sealed key with the context it was sealed for. Throws UpstreamAddressChangedError when the API's origin
 * or path prefix changed since, and UpstreamAuthError when it is malformed, tampered with, or sealed for another
 * API, placement or name.
 */
export function openUpstreamSecret(privateKeyB64: string, ctx: UpstreamSecretContext, sealed: string): string {
  const parts = sealed.split(".");
  if (parts.length !== 6 || parts[0] !== SEALED_PREFIX) throw new UpstreamAuthError("not a sealed upstream key");
  if (parts[1] !== addressTag(ctx)) throw new UpstreamAddressChangedError("the API's address changed since the key was sealed");
  const aad = Buffer.from(upstreamSecretContext(ctx));
  const [ephPub, iv, ct, tag] = parts.slice(2).map((p) => Buffer.from(p, "base64url"));
  try {
    const privateKey = createPrivateKey({ key: Buffer.from(privateKeyB64, "base64"), format: "der", type: "pkcs8" });
    const publicKey = createPublicKey({ key: ephPub, format: "der", type: "spki" });
    const decipher = createDecipheriv("aes-256-gcm", aesKey(diffieHellman({ privateKey, publicKey }), ephPub, aad), iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    throw new UpstreamAuthError("the upstream key could not be opened");
  }
}

/** Checks what the seller typed. Header names are tokens and not ones the gateway owns; values have no line breaks. */
export function validateUpstreamAuth(raw: { in: unknown; name: unknown; value: unknown }): UpstreamCredential {
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
  if (value.length < 8) throw new UpstreamAuthError("That key looks too short. Paste the whole key.");
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
 * hex encoded (only for parts of MIN_SECRET_PART characters or more, so a short token's hex does not match ordinary
 * digits). Matching ignores case, so the hex form also stands for upper case hex.
 */
const readForms = (s: string) => [
  ...(s.includes("+") ? [s.replaceAll("+", " ")] : []),
  ...(s.length >= MIN_SECRET_PART ? [Buffer.from(s, "utf8").toString("hex")] : []),
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
  const forms = upstreamSecretParts(value).flatMap((part) => [part, ...base64Forms(part), ...readForms(part)]).flatMap((text) => {
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
const plainNeedles = (value: string) =>
  [...new Set(upstreamSecretParts(value).flatMap((p) => [p, ...base64Forms(p), ...readForms(p)]).map((f) => f.toLowerCase()))].filter(Boolean);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", plus: "+", sol: "/", equals: "=", colon: ":", num: "#", percnt: "%",
  lowbar: "_", hyphen: "-", dash: "-", period: ".", comma: ",", excl: "!", quest: "?", lpar: "(", rpar: ")", ast: "*",
  commat: "@", dollar: "$", semi: ";", tilde: "~", verbar: "|", bsol: "\\", lsqb: "[", rsqb: "]", lcub: "{", rcub: "}",
  nbsp: " ",
};
const codePoint = (n: number, whole: string) => (n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole);

const JSON_CONTROL: Record<string, string> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/** One round of unescaping: JSON backslash escapes (\uXXXX, \/ \" \\, \n and the like), \xXX, HTML entities (named, decimal, hex), and %XX for ASCII. */
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
    .replace(/%([0-7][0-9a-fA-F])/g, (_w, h: string) => String.fromCharCode(parseInt(h, 16)));
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
const MAX_BASE64_TOKENS = 200;
const MAX_BASE64_TOKEN_LENGTH = 4096;

/** The decoded base64/base64url tokens of 16 characters or more in the texts: at most 200, each up to 4 KB. */
function decodedBase64Tokens(texts: string[]): string[] {
  const out: string[] = [];
  for (const text of texts) {
    for (const m of text.matchAll(BASE64_TOKEN)) {
      if (out.length >= MAX_BASE64_TOKENS) return out;
      const token = m[0].slice(0, MAX_BASE64_TOKEN_LENGTH);
      out.push(normaliseText(Buffer.from(token, "base64").toString("latin1")));
    }
  }
  return out;
}

/**
 * True when text contains the key (or one of its parts), in any case. It looks for the forms of
 * upstreamSecretForms as they are, then in the text with escapes undone (mixed percent-encoding, \u00XX escapes of
 * every character as ASP.NET writes them, decimal and hex HTML entities), then inside base64 and base64url tokens
 * of the answer. This is defence in depth, not a complete check: it catches common encodings, not every one. An
 * upstream can always transform the key in a way no check foresees, so sending the key in a header (which answers
 * echo less often than URLs) is the safer default.
 */
export function textLeaksSecret(text: string | null | undefined, value: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  if (upstreamSecretForms(value).some((f) => lower.includes(f))) return true;
  const needles = plainNeedles(value);
  const normalised = [normaliseText(text)];
  if (needles.some((n) => n.includes(" "))) normalised.push(normaliseText(text.replaceAll("+", " ")));
  const found = (t: string) => {
    const l = t.toLowerCase();
    return needles.some((n) => l.includes(n));
  };
  return normalised.some(found) || decodedBase64Tokens([text, ...normalised]).some(found);
}

/** True when any of the texts contains the key, by the same check as textLeaksSecret (example requests, say). */
export function keyAppearsIn(value: string, texts: readonly (string | null | undefined)[]): boolean {
  return texts.some((t) => textLeaksSecret(t, value));
}

/** What redactUpstreamSecret returns when the key is in the text but only after decoding, so it can't be cut out. */
export const WITHHELD_TEXT = "This text was withheld because it contained the API's key.";

/**
 * Replaces every form of the key it can locate (upstreamSecretForms, any case) with "[key]". When the key is still
 * there after that (only found once the text is decoded), the whole text is replaced with WITHHELD_TEXT.
 */
export function redactUpstreamSecret(text: string, value: string): string {
  const alternatives = upstreamSecretForms(value).map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const redacted = text.replace(new RegExp(alternatives.join("|"), "gi"), "[key]");
  return textLeaksSecret(redacted, value) ? WITHHELD_TEXT : redacted;
}

/** True when an upstream answer contains the key (or one of its parts), which must then not be passed on to a buyer. */
export function answerLeaksSecret(body: string, credential: UpstreamCredential | null | undefined): boolean {
  if (!credential) return false;
  return textLeaksSecret(body, credential.value);
}
