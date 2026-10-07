import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildLoginMessage, clearSessionCookieHeader, createSessionToken, issueLoginChallenge, openLoginChallenge,
  readCookie, readSessionToken, sessionCookieHeader,
} from "./session";

const ADDR = "addr_test1qqexampleexampleexample";
const NOW = 1_800_000_000;

describe("session tokens", () => {
  it("round-trips a seller session", () => {
    const token = createSessionToken("sel_1", ADDR, NOW);
    expect(readSessionToken(token, NOW + 60)).toEqual({ sellerId: "sel_1", addr: ADDR, jti: expect.stringMatching(/^[\w-]{22}$/), exp: NOW + 7 * 24 * 3600 });
  });

  it("gives every session its own id", () => {
    const a = readSessionToken(createSessionToken("sel_1", ADDR, NOW), NOW);
    const b = readSessionToken(createSessionToken("sel_1", ADDR, NOW), NOW);
    expect(a?.jti).not.toBe(b?.jti);
  });

  it("refuses a validly signed token issued before sessions had an id, so that seller signs in again", () => {
    const body = Buffer.from(JSON.stringify({ sid: "sel_1", addr: ADDR, exp: NOW + 999 })).toString("base64url");
    const sig = createHmac("sha256", process.env.SESSION_SECRET!).update(`session.${body}`).digest("base64url");
    expect(readSessionToken(`${body}.${sig}`, NOW)).toBeNull();
  });

  it("rejects a tampered token", () => {
    const [body, sig] = createSessionToken("sel_1", ADDR, NOW).split(".");
    const forged = Buffer.from(JSON.stringify({ sid: "sel_2", addr: ADDR, exp: NOW + 999 })).toString("base64url");
    expect(readSessionToken(`${forged}.${sig}`, NOW)).toBeNull();
    expect(readSessionToken(`${body}.${sig}x`, NOW)).toBeNull();
    expect(readSessionToken("garbage", NOW)).toBeNull();
  });

  it("expires after 7 days", () => {
    const token = createSessionToken("sel_1", ADDR, NOW);
    expect(readSessionToken(token, NOW + 7 * 24 * 3600 + 1)).toBeNull();
  });

  it("never accepts a login token as a session", () => {
    const { nonceToken } = issueLoginChallenge(ADDR, NOW);
    expect(readSessionToken(nonceToken, NOW)).toBeNull();
  });
});

describe("login challenge", () => {
  it("rebuilds the exact message the wallet was asked to sign", () => {
    const { message, nonceToken } = issueLoginChallenge(ADDR, NOW);
    expect(openLoginChallenge(nonceToken, NOW + 10)).toEqual({ addr: ADDR, message, nonce: expect.stringMatching(/^[0-9a-f]{32}$/), exp: NOW + 300 });
    expect(message).toContain(ADDR);
    expect(message).toContain("moves no funds");
    expect(message).toContain("Site: web.hirakumi.test");
  });

  it("expires after 5 minutes", () => {
    const { nonceToken } = issueLoginChallenge(ADDR, NOW);
    expect(openLoginChallenge(nonceToken, NOW + 301)).toBeNull();
  });

  it("does not accept a session token as a login challenge", () => {
    expect(openLoginChallenge(createSessionToken("sel_1", ADDR, NOW), NOW)).toBeNull();
  });

  it("builds a readable message", () => {
    expect(buildLoginMessage(ADDR, "ab12", "2026-10-06T12:00:00.000Z")).toBe(
      [
        "Sign in to Hirakumi",
        "This proves you control this wallet. It costs nothing and moves no funds.",
        "Site: web.hirakumi.test",
        `Wallet: ${ADDR}`,
        "Network: cardano:preprod",
        "Nonce: ab12",
        "Expires: 2026-10-06T12:00:00.000Z",
      ].join("\n"),
    );
  });
});

describe("cookies", () => {
  it("sets an HttpOnly, SameSite=Lax cookie for 7 days", () => {
    const header = sessionCookieHeader("tok");
    expect(header).toBe("hk_session=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800");
    expect(clearSessionCookieHeader()).toBe("hk_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
  });

  it("reads one cookie from a Cookie header", () => {
    expect(readCookie("a=1; hk_session=xyz.abc; b=2", "hk_session")).toBe("xyz.abc");
    expect(readCookie(null, "hk_session")).toBeNull();
    expect(readCookie("a=1", "hk_session")).toBeNull();
  });
});
