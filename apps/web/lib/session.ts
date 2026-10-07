import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "./env";

export const SESSION_COOKIE = "hk_session";
const SESSION_TTL_S = 7 * 24 * 3600;
const LOGIN_TTL_S = 5 * 60;

export type SessionInfo = { sellerId: string; addr: string };
/** A session token's signed contents. jti is the session's id: logout revokes it (lib/repo/sessions.ts). */
export type SessionClaims = SessionInfo & { jti: string; exp: number };
type SessionPayload = { sid: string; addr: string; jti: string; exp: number };
type LoginPayload = { addr: string; nonce: string; exp: number };

const nowSeconds = () => Math.floor(Date.now() / 1000);

type SealKind = "session" | "login" | "act";

function mac(kind: SealKind, body: string): Buffer {
  return createHmac("sha256", env.sessionSecret()).update(`${kind}.${body}`).digest();
}

function seal(kind: SealKind, payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${mac(kind, body).toString("base64url")}`;
}

function unseal<T extends { exp: number }>(kind: SealKind, token: string, now: number): T | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = mac(kind, body);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload: T;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
  if (typeof payload.exp !== "number" || payload.exp <= now) return null;
  return payload;
}

export function createSessionToken(sellerId: string, addr: string, now = nowSeconds()): string {
  const jti = randomBytes(16).toString("base64url");
  return seal("session", { sid: sellerId, addr, jti, exp: now + SESSION_TTL_S } satisfies SessionPayload);
}

/**
 * The claims of a validly signed, unexpired session token, or null. This alone does not make a session valid: it may
 * have been revoked (liveSession in lib/repo/sessions.ts checks). A token without a jti was issued before sessions
 * could be revoked and is refused, so that seller signs in again.
 */
export function readSessionToken(token: string, now = nowSeconds()): SessionClaims | null {
  const p = unseal<SessionPayload>("session", token, now);
  if (!p || typeof p.sid !== "string" || typeof p.addr !== "string" || typeof p.jti !== "string" || !p.jti) return null;
  return { sellerId: p.sid, addr: p.addr, jti: p.jti, exp: p.exp };
}

export function sessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_S}${env.secureCookies() ? "; Secure" : ""}`;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${env.secureCookies() ? "; Secure" : ""}`;
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export function buildLoginMessage(addr: string, nonce: string, expiresIso: string): string {
  return [
    "Sign in to Hirakumi",
    "This proves you control this wallet. It costs nothing and moves no funds.",
    `Site: ${new URL(env.webBaseUrl()).host}`,
    `Wallet: ${addr}`,
    "Network: cardano:preprod",
    `Nonce: ${nonce}`,
    `Expires: ${expiresIso}`,
  ].join("\n");
}

export function issueLoginChallenge(addr: string, now = nowSeconds()): { message: string; nonceToken: string } {
  const nonce = randomBytes(16).toString("hex");
  const exp = now + LOGIN_TTL_S;
  return {
    message: buildLoginMessage(addr, nonce, new Date(exp * 1000).toISOString()),
    nonceToken: seal("login", { addr, nonce, exp } satisfies LoginPayload),
  };
}

export type LoginChallenge = { addr: string; message: string; nonce: string; exp: number };

export function openLoginChallenge(nonceToken: string, now = nowSeconds()): LoginChallenge | null {
  const p = unseal<LoginPayload>("login", nonceToken, now);
  if (!p || typeof p.addr !== "string" || typeof p.nonce !== "string") return null;
  return { addr: p.addr, message: buildLoginMessage(p.addr, p.nonce, new Date(p.exp * 1000).toISOString()), nonce: p.nonce, exp: p.exp };
}

/**
 * A wallet step on a one-time link (/act/<token>, lib/act.ts): the message the API owner signs to approve one action,
 * sealed like a login challenge (same HMAC, a random nonce used up once in used_login_nonces). `act` is the link's
 * row id, so a signature for one link can't be used on another. `lines` say what is approved, such as the price.
 */
type ActPayload = { addr: string; nonce: string; exp: number; act: string; lines: string[] };
export type ActChallenge = { addr: string; actId: string; lines: string[]; message: string; nonce: string; exp: number };

export function buildActMessage(addr: string, actId: string, lines: string[], nonce: string, expiresIso: string): string {
  return [
    ...lines,
    "This approves one action on Hirakumi. It costs nothing and moves no funds.",
    `Site: ${new URL(env.webBaseUrl()).host}`,
    `Wallet: ${addr}`,
    `Link: ${actId}`,
    "Network: cardano:preprod",
    `Nonce: ${nonce}`,
    `Expires: ${expiresIso}`,
  ].join("\n");
}

export function issueActChallenge(addr: string, actId: string, lines: string[], now = nowSeconds()): { message: string; nonceToken: string } {
  const nonce = randomBytes(16).toString("hex");
  const exp = now + LOGIN_TTL_S;
  return {
    message: buildActMessage(addr, actId, lines, nonce, new Date(exp * 1000).toISOString()),
    nonceToken: seal("act", { addr, nonce, exp, act: actId, lines } satisfies ActPayload),
  };
}

export function openActChallenge(nonceToken: string, now = nowSeconds()): ActChallenge | null {
  const p = unseal<ActPayload>("act", nonceToken, now);
  if (!p || typeof p.addr !== "string" || typeof p.nonce !== "string" || typeof p.act !== "string" || !Array.isArray(p.lines)
    || !p.lines.every((l) => typeof l === "string")) return null;
  return {
    addr: p.addr, actId: p.act, lines: p.lines, nonce: p.nonce, exp: p.exp,
    message: buildActMessage(p.addr, p.act, p.lines, p.nonce, new Date(p.exp * 1000).toISOString()),
  };
}
