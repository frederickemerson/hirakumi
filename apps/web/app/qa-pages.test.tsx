// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSql } from "@/lib/db";
import { createSessionToken } from "@/lib/session";
import { resetDb } from "@/test/db";
import { seedApi, seedSeller } from "@/test/factories";
import AccountPage from "./account/page";
import { metadata as apisMetadata } from "./apis/page";
import ApiLayout, { generateMetadata as apiLayoutMetadata } from "./apis/[apiId]/layout";
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
