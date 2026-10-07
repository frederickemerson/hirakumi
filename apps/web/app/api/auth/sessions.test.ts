import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSql, getSql } from "@/lib/db";
import { requireSeller } from "@/lib/http";
import { resetDb } from "@/test/db";
import { seedSeller } from "@/test/factories";
import { cookieFor, jsonRequest } from "@/test/requests";
import { POST as logout } from "./logout/route";
import { GET as me } from "./me/route";

const logoutWith = (cookie: string) =>
  logout(new Request("https://web.hirakumi.test/api/auth/logout", { method: "POST", headers: { cookie } }));
const signedIn = async (cookie: string) => ((await (await me(jsonRequest("/api/auth/me", { cookie }))).json()) as { signedIn: boolean }).signedIn;
const sellerRoute = (cookie: string) => requireSeller(jsonRequest("/api/apis", { cookie }));

describe("seller sessions", () => {
  beforeEach(resetDb);

  it("after logout, a copied session cookie no longer works on /me or seller routes", async () => {
    const s = await seedSeller();
    const cookie = cookieFor(s);
    expect(await signedIn(cookie)).toBe(true);
    const out = await logoutWith(cookie);
    expect(out.status).toBe(303);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await signedIn(cookie)).toBe(false);
    const res = await sellerRoute(cookie);
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(401);
  });

  it("logout ends only that session: the seller's other sessions keep working", async () => {
    const s = await seedSeller();
    const [laptop, phone] = [cookieFor(s), cookieFor(s)];
    await logoutWith(laptop);
    expect(await signedIn(laptop)).toBe(false);
    expect(await signedIn(phone)).toBe(true);
    expect(await sellerRoute(phone)).toEqual({ sellerId: s.id, addr: s.cardanoAddr });
  });

  it("logging out twice, or without a valid session, still clears the cookie", async () => {
    const s = await seedSeller();
    const cookie = cookieFor(s);
    expect((await logoutWith(cookie)).status).toBe(303);
    expect((await logoutWith(cookie)).status).toBe(303);
    expect((await logoutWith("hk_session=garbage")).status).toBe(303);
  });

  it("a deleted seller's sessions stop working", async () => {
    const s = await seedSeller();
    const cookie = cookieFor(s);
    await getSql()`delete from sellers where id = ${s.id}`;
    expect(await signedIn(cookie)).toBe(false);
    expect(((await sellerRoute(cookie)) as Response).status).toBe(401);
  });

  describe("when the database is unreachable", () => {
    const mainUrl = process.env.DATABASE_URL;
    let cookie: string;
    beforeEach(async () => {
      cookie = cookieFor(await seedSeller());
      await closeSql();
      process.env.DATABASE_URL = "postgres://hirakumi:hirakumi@127.0.0.1:1/unreachable";
    });
    afterEach(async () => {
      await closeSql();
      process.env.DATABASE_URL = mainUrl;
    });

    it("seller routes and /me fail closed with 503", async () => {
      expect(((await sellerRoute(cookie)) as Response).status).toBe(503);
      expect((await me(jsonRequest("/api/auth/me", { cookie }))).status).toBe(503);
    });

    it("logout answers 503 and keeps the cookie, so the seller can try again", async () => {
      const res = await logoutWith(cookie);
      expect(res.status).toBe(503);
      expect(res.headers.get("set-cookie")).toBeNull();
    });
  });
});
