import { describe, expect, it, vi } from "vitest";
import {
  ACTIVE_LISTING_STATES,
  checkListingBase,
  compareBases,
  judgeListingBase,
  LISTED_BY_OTHER,
  normalizeBasePath,
  normalizeOrigin,
  overlapWarning,
  takenEarly,
  type ListedBase,
} from "../src/listingBase";

const listed = (o: Partial<ListedBase> = {}): ListedBase => ({
  id: "api_other", sellerId: "sel_other", name: "Other API", origin: "https://h.com", pathPrefix: "/", ...o,
});

describe("normalizing a base", () => {
  it("lowercases the origin and drops default ports and trailing slashes", () => {
    expect(normalizeOrigin("HTTPS://Price.Example.DEV")).toBe("https://price.example.dev");
    expect(normalizeOrigin("https://h.com:443")).toBe("https://h.com");
    expect(normalizeOrigin("http://h.com:80/")).toBe("http://h.com");
    expect(normalizeOrigin("https://h.com:8443")).toBe("https://h.com:8443");
    expect(normalizeOrigin("http://h.com:443")).toBe("http://h.com:443");
  });
  it("drops a trailing host dot, so api.example.com. is the same API as api.example.com", () => {
    expect(normalizeOrigin("https://api.example.com.")).toBe("https://api.example.com");
    expect(normalizeOrigin("https://API.example.com.:443/")).toBe("https://api.example.com");
    expect(normalizeOrigin("https://api.example.com..:8443")).toBe("https://api.example.com:8443");
    expect(normalizeOrigin("http://127.0.0.1:4100")).toBe("http://127.0.0.1:4100");
    expect(judgeListingBase({ origin: "https://h.com.", pathPrefix: "/t", sellerId: "sel_me" }, [listed()])).toEqual({
      ok: false, reason: "taken_by_other", message: LISTED_BY_OTHER,
    });
  });
  it("makes the path a directory with one trailing slash", () => {
    expect(normalizeBasePath("")).toBe("/");
    expect(normalizeBasePath("/")).toBe("/");
    expect(normalizeBasePath("/v1")).toBe("/v1/");
    expect(normalizeBasePath("/v1/")).toBe("/v1/");
  });
});

describe("comparing bases", () => {
  const b = (origin: string, pathPrefix: string) => ({ origin, pathPrefix });
  it("is exact after normalizing", () => {
    expect(compareBases(b("https://H.com:443", "/v1"), b("https://h.com", "/v1/"))).toBe("exact");
  });
  it("overlaps when one is a folder of the other", () => {
    expect(compareBases(b("https://h.com", "/v1"), b("https://h.com", "/v1/prices"))).toBe("overlap");
    expect(compareBases(b("https://h.com", "/v1/prices/"), b("https://h.com", "/v1/"))).toBe("overlap");
    expect(compareBases(b("https://h.com", "/"), b("https://h.com", "/v1"))).toBe("overlap");
  });
  it("only at segment boundaries: /v1 and /v10 do not overlap", () => {
    expect(compareBases(b("https://h.com", "/v1"), b("https://h.com", "/v10"))).toBeNull();
    expect(compareBases(b("https://h.com", "/v1/"), b("https://h.com", "/v10/"))).toBeNull();
  });
  it("never across origins", () => {
    expect(compareBases(b("https://h.com", "/"), b("https://h.com:8443", "/"))).toBeNull();
    expect(compareBases(b("https://h.com", "/"), b("http://h.com", "/"))).toBeNull();
  });
});

describe("judging a base against active listings", () => {
  const me = { sellerId: "sel_me", origin: "https://h.com", pathPrefix: "/v1" };

  it("blocks an exact duplicate by another account without naming it", () => {
    const v = judgeListingBase(me, [listed({ pathPrefix: "/v1/" })]);
    expect(v).toEqual({ ok: false, reason: "taken_by_other", message: LISTED_BY_OTHER });
    expect(LISTED_BY_OTHER).toBe("This API is already registered on Hirakumi by another account, so it can't be listed again. If it's yours, retire that listing first.");
    expect(JSON.stringify(v)).not.toMatch(/Other API|sel_other|api_other/);
  });
  it("blocks an overlap by another account", () => {
    expect(judgeListingBase(me, [listed({ pathPrefix: "/" })])).toMatchObject({ ok: false, reason: "taken_by_other" });
    expect(judgeListingBase(me, [listed({ pathPrefix: "/v1/prices" })])).toMatchObject({ ok: false, reason: "taken_by_other" });
  });
  it("blocks an exact duplicate by the same account", () => {
    const exact = judgeListingBase(me, [listed({ sellerId: "sel_me", name: "My Prices", pathPrefix: "/v1" })]);
    expect(exact).toEqual({ ok: false, reason: "duplicate_own", message: "You already list this API as My Prices. Retire that listing first." });
  });
  it("allows an overlap by the same account, with a warning naming the seller's own listing", () => {
    const v = judgeListingBase(me, [listed({ sellerId: "sel_me", name: "My Prices", pathPrefix: "/v1/prices" })]);
    expect(v).toEqual({ ok: true, warnings: [overlapWarning("My Prices")] });
    expect(overlapWarning("My Prices")).toBe("This overlaps your listing My Prices, so some calls may be sold in both.");
  });
  it("ignores other origins and non-overlapping paths", () => {
    expect(judgeListingBase(me, [listed({ pathPrefix: "/v10" }), listed({ origin: "https://other.com", pathPrefix: "/v1" })]))
      .toEqual({ ok: true, warnings: [] });
  });
  it("another account wins over a same-account warning", () => {
    const v = judgeListingBase(me, [listed({ sellerId: "sel_me", pathPrefix: "/v1/x" }), listed({ pathPrefix: "/v1/y" })]);
    expect(v).toMatchObject({ ok: false, reason: "taken_by_other" });
  });
});

describe("early check on a known base", () => {
  const me = { sellerId: "sel_me", origin: "https://H.com", pathPrefix: "/v1" };
  it("is taken when another account lists the same base, a folder above it or one below it", () => {
    for (const pathPrefix of ["/v1", "/v1/", "/", "", "/v1/x"]) expect(takenEarly(me, [listed({ pathPrefix })]), pathPrefix).toBe(true);
  });
  it("is not taken by a sibling, a look-alike, another origin or the seller's own listing", () => {
    expect(takenEarly(me, [listed({ pathPrefix: "/v2" })])).toBe(false);
    expect(takenEarly(me, [listed({ pathPrefix: "/v10" })])).toBe(false);
    expect(takenEarly(me, [listed({ origin: "https://other.com", pathPrefix: "/" })])).toBe(false);
    expect(takenEarly(me, [listed({ sellerId: "sel_me", pathPrefix: "/v1" })])).toBe(false);
  });
});

describe("checkListingBase", () => {
  it("locks the normalized origin, then reads active listings on it, excluding itself", async () => {
    const calls: { text: string; params: unknown[] }[] = [];
    const query = vi.fn(async (text: string, params: unknown[]) => {
      calls.push({ text, params });
      return text.includes("pg_advisory_xact_lock")
        ? []
        : [{ id: "api_other", owner: "sel_other", name: "Other API", origin: "https://h.com", prefix: "/v1" }];
    });
    const v = await checkListingBase(query, { apiId: "api_me", sellerId: "sel_me", origin: "HTTPS://h.com:443", pathPrefix: "/v1" });
    expect(v).toMatchObject({ ok: false, reason: "taken_by_other" });
    expect(calls[0].text).toContain("pg_advisory_xact_lock");
    expect(calls[0].params).toEqual(["https://h.com"]);
    expect(calls[1].params).toEqual(["https://h.com", "api_me"]);
    for (const state of ACTIVE_LISTING_STATES) expect(calls[1].text).toContain(`'${state}'`);
  });
});
