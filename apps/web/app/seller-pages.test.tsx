// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionToken } from "@/lib/session";
import { resetDb } from "@/test/db";
import { seedApi, seedSeller } from "@/test/factories";
import ApiLayout from "./apis/[apiId]/layout";
import NewApiPage from "./apis/new/page";
import SokosumiSetupPage from "./setup/page";

const jar = vi.hoisted(() => ({ token: null as string | null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "hk_session" && jar.token ? { value: jar.token } : undefined) }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/apis/x/overview",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  notFound: () => {
    throw new Error("not found");
  },
}));

/** No reserved side column anywhere: no two-column grid, and no fixed-width track for a guide. */
function expectNoGuideColumn(container: HTMLElement) {
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(screen.queryByText("Need help?")).toBeNull();
  for (const el of container.querySelectorAll<HTMLElement>("*")) {
    expect(el.className.toString()).not.toMatch(/grid-cols-\[minmax\(0,1fr\)_\d+px\]/);
  }
  const root = container.firstElementChild as HTMLElement;
  expect(root.className).not.toMatch(/\bgrid\b/);
}

let sellerId = "";
beforeEach(async () => {
  await resetDb();
  const seller = await seedSeller();
  jar.token = createSessionToken(seller.id, seller.cardanoAddr);
  sellerId = seller.id;
});

describe("seller pages without the step guide", () => {
  it("an API's pages take the full width, with the step tab still pointing at the current step", async () => {
    const api = await seedApi(sellerId, "endpoints_confirmed");
    const ui = await ApiLayout({ children: <p>Step content</p>, params: Promise.resolve({ apiId: api.id }) });
    const { container } = render(ui);
    expect(screen.getByText("Step content")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Listing steps" })).toHaveAttribute("href", `/apis/${api.id}/ownership`);
    expectNoGuideColumn(container);
  });

  it("/apis/new has no guide column", async () => {
    const { container } = render(await NewApiPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    expectNoGuideColumn(container);
  });

  it("/setup has no guide column", async () => {
    const { container } = render(await SokosumiSetupPage({ searchParams: Promise.resolve({ t: "tok" }) }));
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    expectNoGuideColumn(container);
  });
});
