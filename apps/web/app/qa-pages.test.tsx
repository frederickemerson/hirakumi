// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSql } from "@/lib/db";
import { createSessionToken } from "@/lib/session";
import { resetDb } from "@/test/db";
import { getAccount } from "@/lib/repo/account";
import { seedApi, seedOnboardStep, seedSeller } from "@/test/factories";
import AccountPage from "./account/page";
import ApisPage, { metadata as apisMetadata } from "./apis/page";
import ApiLayout, { generateMetadata as apiLayoutMetadata } from "./apis/[apiId]/layout";
import ReviewPage from "./apis/[apiId]/review/page";
import SalesPage from "./apis/[apiId]/sales/page";
import LoginPage, { metadata as loginMetadata } from "./login/page";
import NotFound from "./not-found";
import PublicApiLayout from "./p/[apiId]/layout";
import { generateMetadata as publicMetadata } from "./p/[apiId]/page";
import { generateMetadata as tryMetadata } from "./p/[apiId]/try/page";

const jar = vi.hoisted(() => ({ token: null as string | null, pathname: "/apis/x/overview" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "hk_session" && jar.token ? { value: jar.token } : undefined) }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => jar.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  notFound: () => {
    throw new Error("not found");
  },
}));

let sellerId = "";
beforeEach(async () => {
  await resetDb();
  const seller = await seedSeller();
  jar.token = createSessionToken(seller.id, seller.cardanoAddr);
  jar.pathname = "/apis/x/overview";
  sellerId = seller.id;
});

describe("login page (QA 8, 13)", () => {
  it("sends a signed-in seller to next, or to /apis", async () => {
    await expect(LoginPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("redirect /apis");
    await expect(LoginPage({ searchParams: Promise.resolve({ next: "/apis/api_1/overview" }) })).rejects.toThrow("redirect /apis/api_1/overview");
    await expect(LoginPage({ searchParams: Promise.resolve({ next: "//evil.example" }) })).rejects.toThrow("redirect /apis");
  });
  it("says Log in, with a page title", async () => {
    jar.token = null;
    render(await LoginPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Log in with your Cardano wallet");
    expect(document.body.textContent).not.toMatch(/sign in/i);
    expect(loginMetadata.title).toBe("Log in");
  });
});

describe("unknown public API (QA 3)", () => {
  it("the /p layout calls notFound before the page streams", async () => {
    await expect(PublicApiLayout({ children: null, params: Promise.resolve({ apiId: "api_nope" }) })).rejects.toThrow("not found");
    const live = await seedApi(sellerId, "live");
    const ui = await PublicApiLayout({ children: <p>page</p>, params: Promise.resolve({ apiId: live.id }) });
    render(<>{ui}</>);
    expect(screen.getByText("page")).toBeInTheDocument();
  });
  it("the 404 page links home and to your APIs", () => {
    render(<NotFound />);
    expect(screen.getByRole("link", { name: "Go home" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Go to your APIs" })).toHaveAttribute("href", "/apis");
  });
});

describe("API tabs (QA 9)", () => {
  it.each(["live", "retired"] as const)("hides Listing steps once the API is %s", async (state) => {
    const api = await seedApi(sellerId, state);
    render(await ApiLayout({ children: <p>x</p>, params: Promise.resolve({ apiId: api.id }) }));
    expect(screen.queryByRole("link", { name: "Listing steps" })).toBeNull();
    expect(screen.getByRole("link", { name: "Overview" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sales" })).toBeInTheDocument();
  });
  it("keeps Listing steps while the API is being listed", async () => {
    const api = await seedApi(sellerId, "described");
    render(await ApiLayout({ children: <p>x</p>, params: Promise.resolve({ apiId: api.id }) }));
    expect(screen.getByRole("link", { name: "Listing steps" })).toBeInTheDocument();
  });
});

describe("one status label on /apis and /account (QA 11, 12)", () => {
  it("shows the same status for the same API on both pages", async () => {
    const described = await seedApi(sellerId, "described", { name: "Alpha API" });
    const stopped = await seedApi(sellerId, "parsed", { name: "Beta API" });
    await seedOnboardStep(stopped.id, "describe", "failed");
    await seedApi(sellerId, "retired", { name: "Gamma API" });
    await seedApi(sellerId, "live", { name: "Delta API" });
    const expected = { "Alpha API": "In progress", "Beta API": "Stopped", "Gamma API": "Retired", "Delta API": "Live" };

    const apis = render(await ApisPage());
    for (const [name, label] of Object.entries(expected)) {
      const row = screen.getByRole("link", { name }).closest("li")!;
      expect(within(row).getByText(label)).toBeInTheDocument();
    }
    apis.unmount();
    const account = await getAccount(getSql(), sellerId);
    for (const [name, label] of Object.entries(expected)) {
      expect(account!.apis.find((a) => a.name === name)!.badge.label).toBe(label);
    }
    expect(described.id).toBeTruthy();
  });
});

describe("page titles (QA 17, 20)", () => {
  it("names the API on its public, try and seller pages", async () => {
    const api = await seedApi(sellerId, "live", { name: "Weather API" });
    const params = Promise.resolve({ apiId: api.id });
    expect((await publicMetadata({ params })).title).toBe("Weather API status");
    expect((await tryMetadata({ params })).title).toBe("Try Weather API live");
    expect((await apiLayoutMetadata({ params })).title).toEqual({ template: "%s | Weather API | Hirakumi", default: "Weather API" });
    expect(apisMetadata.title).toBe("Your APIs");
  });
  it("the Sales heading has the API name", async () => {
    const api = await seedApi(sellerId, "live", { name: "Weather API" });
    render(await SalesPage({ params: Promise.resolve({ apiId: api.id }) }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Weather API sales");
  });
  it("the account page says \"Go to your APIs\"", async () => {
    await getSql()`select 1`;
    render(await AccountPage());
    expect(screen.getByRole("link", { name: "Go to your APIs" })).toHaveAttribute("href", "/apis");
  });
});

describe("key rotation before publishing", () => {
  it.each(["rule_built", "priced"] as const)("the review page at %s shows the key form with the stored key", async (state) => {
    const api = await seedApi(sellerId, state);
    await getSql()`update apis set upstream_auth = ${getSql().json({ in: "header", name: "X-API-Key", sealed: "hks1.x", hint: "WXYZ" })} where id = ${api.id}`;
    render(await ReviewPage({ params: Promise.resolve({ apiId: api.id }) }));
    expect(screen.getByRole("heading", { name: "Your API's key" })).toBeInTheDocument();
    expect(screen.getByTestId("upstream-auth-current")).toHaveTextContent("X-API-Key in header, ending in WXYZ");
    expect(document.body.textContent).not.toContain("hks1");
  });
  it("the review page lists the parts of a key sent in several places, never the sealed bag", async () => {
    const api = await seedApi(sellerId, "priced");
    const stored = { v: 3, parts: [{ in: "header", name: "apikey", hint: "WXYZ" }, { in: "header", name: "Authorization", hint: "" }], sealed: "hks3.x" };
    await getSql()`update apis set upstream_auth = ${getSql().json(stored)} where id = ${api.id}`;
    render(await ReviewPage({ params: Promise.resolve({ apiId: api.id }) }));
    expect(screen.getByTestId("upstream-auth-current")).toHaveTextContent("Header apikey ••••WXYZ");
    expect(screen.getByTestId("upstream-auth-current")).toHaveTextContent("Header Authorization");
    expect(document.body.textContent).not.toContain("hks3");
  });
});
