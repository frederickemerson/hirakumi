import { beforeEach, describe, expect, it } from "vitest";
import { shortAddress } from "@/lib/copy";
import { createSessionToken } from "@/lib/session";
import { resetDb } from "@/test/db";
import { seedSeller } from "@/test/factories";
import { cookieFor, jsonRequest } from "@/test/requests";
import { GET as me } from "./route";

const ADDR = "addr_test1qzx9hu8j4ah3auytk0mwcupd69hpc52t0cw39a65ndrah86djs784u92a3m5w475w3w35tyd6v3qumkze80j8a6h5tuqq5xe8y";

describe("GET /api/auth/me", () => {
  beforeEach(resetDb);

  it("says signed out without a session cookie, and is never cached", async () => {
    const res = await me(jsonRequest("/api/auth/me"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ signedIn: false });
  });

  it("says signed out for a forged or expired session", async () => {
    const forged = await me(jsonRequest("/api/auth/me", { cookie: "hk_session=eyJzaWQiOiJ4In0.bad" }));
    expect(await forged.json()).toEqual({ signedIn: false });
    const expired = createSessionToken("sel_1", ADDR, Math.floor(Date.now() / 1000) - 8 * 24 * 3600);
    const old = await me(jsonRequest("/api/auth/me", { cookie: `hk_session=${expired}` }));
    expect(await old.json()).toEqual({ signedIn: false });
  });

  it("returns only the short wallet address when signed in", async () => {
    const seller = await seedSeller(ADDR);
    const res = await me(jsonRequest("/api/auth/me", { cookie: cookieFor(seller) }));
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toEqual({ signedIn: true, address: shortAddress(ADDR) });
    expect(JSON.stringify(body)).not.toContain(seller.id);
    expect(JSON.stringify(body)).not.toContain(ADDR);
  });
});
