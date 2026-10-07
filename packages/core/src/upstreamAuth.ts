import {
  createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes,
} from "node:crypto";

/**
 * APIs that need a key. The seller gives a header (or query parameter) name and the key. The web app seals the key
 * to the gateway's public key (X25519 + HKDF-SHA256 + AES-256-GCM), so only the gateway can read it: the web app,
 * the coworker and the database never hold it in the clear, and it is never shown again. The API's id is bound in
 * as associated data, so a sealed key copied to another listing does not open.
 *
 * The gateway adds the key to upstream requests only, and every upstream URL is already checked to be on the
 * proven origin and under the proven folder (urlWithinBase), and redirects are never followed.
 */
export type UpstreamAuthPlacement = "header" | "query";
/** What is stored in apis.upstream_auth. `hint` is the last 4 characters, for the seller to recognise the key. */
export type StoredUpstreamAuth = { in: UpstreamAuthPlacement; name: string; sealed: string; hint: string };
/** What the gateway uses after opening it. */
export type UpstreamCredential = { in: UpstreamAuthPlacement; name: string; value: string };

export class UpstreamAuthError extends Error {}

const SEALED_PREFIX = "hks1";
const INFO = Buffer.from("hirakumi upstream-auth v1");
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

function aesKey(shared: Buffer, ephemeralPub: Buffer, apiId: string): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, Buffer.concat([ephemeralPub, Buffer.from(apiId)]), INFO, 32));
}

/** Seals a key for one API. Only the holder of the private key can open it, and only for that API id. */
export function sealUpstreamSecret(publicKeyB64: string, apiId: string, secret: string): string {
  const publicKey = createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" });
  const eph = generateKeyPairSync("x25519");
  const ephPub = eph.publicKey.export({ type: "spki", format: "der" });
  const key = aesKey(diffieHellman({ privateKey: eph.privateKey, publicKey }), ephPub, apiId);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(apiId));
  const ct = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [SEALED_PREFIX, ephPub, iv, ct, cipher.getAuthTag()].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

/** Opens a sealed key. Throws UpstreamAuthError when it is malformed, tampered with, or sealed for another API. */
export function openUpstreamSecret(privateKeyB64: string, apiId: string, sealed: string): string {
  const parts = sealed.split(".");
  if (parts.length !== 5 || parts[0] !== SEALED_PREFIX) throw new UpstreamAuthError("not a sealed upstream key");
  const [ephPub, iv, ct, tag] = parts.slice(1).map((p) => Buffer.from(p, "base64url"));
  try {
    const privateKey = createPrivateKey({ key: Buffer.from(privateKeyB64, "base64"), format: "der", type: "pkcs8" });
    const publicKey = createPublicKey({ key: ephPub, format: "der", type: "spki" });
    const decipher = createDecipheriv("aes-256-gcm", aesKey(diffieHellman({ privateKey, publicKey }), ephPub, apiId), iv);
    decipher.setAAD(Buffer.from(apiId));
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

/**
 * The parts of a key an upstream may repeat: the whole value, for "Bearer abc…", "Token abc…" or "Basic abc…" the
 * token after the scheme word (4 characters or more), and for any value with spaces the part after the last space
 * (8 characters or more).
 */
export function upstreamSecretParts(value: string): string[] {
  const parts = [value];
  const scheme = /^(?:bearer|token|basic|apikey|api-key|key)\s+(.+)$/i.exec(value);
  const token = scheme ? scheme[1].trim() : "";
  if (token.length >= MIN_SCHEME_TOKEN) parts.push(token);
  const last = value.trim().split(/\s+/).pop() ?? "";
  if (last.length >= MIN_SECRET_PART) parts.push(last);
  return [...new Set(parts)];
}

const base64Forms = (s: string) => {
  const b64 = Buffer.from(s, "utf8").toString("base64");
  return [b64, b64.replace(/=+$/, ""), Buffer.from(s, "utf8").toString("base64url")];
};
const htmlEscape = (s: string, quot: string, apos: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', quot).replaceAll("'", apos);

/**
 * Every way the key (or its token part) can be written in an answer or a message: as is and base64/base64url
 * encoded, each of those as is, percent-encoded (encodeURIComponent, or the form encoding URLSearchParams uses for
 * the query), JSON-escaped (also with "\/", and Go-style with & < > as \u0026 \u003c \u003e) and HTML/XML
 * entity-escaped. Matching ignores case (answerLeaksSecret, redactUpstreamSecret), so a form stands for every casing
 * of it, percent-encoded hex and \u00XX escapes included. Longest first, so redaction never leaves part of a longer
 * form behind.
 */
export function upstreamSecretForms(value: string): string[] {
  const forms = upstreamSecretParts(value).flatMap((part) => [part, ...base64Forms(part)]).flatMap((text) => {
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

/** True when text contains the key (or its token part) in any of its forms, in any case. */
export function textLeaksSecret(text: string | null | undefined, value: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return upstreamSecretForms(value).some((f) => lower.includes(f));
}

/** Replaces every form of the key in text (any case) with "[key]". */
export function redactUpstreamSecret(text: string, value: string): string {
  const alternatives = upstreamSecretForms(value).map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return text.replace(new RegExp(alternatives.join("|"), "gi"), "[key]");
}

/** True when an upstream answer contains the key (or its token part), which must then not be passed on to a buyer. */
export function answerLeaksSecret(body: string, credential: UpstreamCredential | null | undefined): boolean {
  if (!credential) return false;
  return textLeaksSecret(body, credential.value);
}
