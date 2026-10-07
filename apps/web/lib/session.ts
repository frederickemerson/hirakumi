import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "./env";

export const SESSION_COOKIE = "hk_session";
const SESSION_TTL_S = 7 * 24 * 3600;
const LOGIN_TTL_S = 5 * 60;

export type SessionInfo = { sellerId: string; addr: string };
type SessionPayload = { sid: string; addr: string; exp: number };
type LoginPayload = { addr: string; nonce: string; exp: number };

const nowSeconds = () => Math.floor(Date.now() / 1000);

function mac(kind: "session" | "login", body: string): Buffer {
  return createHmac("sha256", env.sessionSecret()).update(`${kind}.${body}`).digest();
}

function seal(kind: "session" | "login", payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${mac(kind, body).toString("base64url")}`;
}

function unseal<T extends { exp: number }>(kind: "session" | "login", token: string, now: number): T | null {
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
  return seal("session", { sid: sellerId, addr, exp: now + SESSION_TTL_S } satisfies SessionPayload);
}

export function readSessionToken(token: string, now = nowSeconds()): SessionInfo | null {
  const p = unseal<SessionPayload>("session", token, now);
  if (!p || typeof p.sid !== "string" || typeof p.addr !== "string") return null;
  return { sellerId: p.sid, addr: p.addr };
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
