// @vitest-environment jsdom
/**
 * "Try it live" is the same button on every surface that shows a live API: a working link when it is
 * healthy, a disabled button with the reason when it is Down. Each page below renders against the test DB.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { inferTextRule } from "@hirakumi/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSql } from "@/lib/db";
import { DEMO_API_ID } from "@/lib/demo";
import { getApiForSeller } from "@/lib/repo/apis";
import type { Health } from "@/lib/types";
import { resetDb } from "@/test/db";
import { seedApi, seedOperation, seedPack, seedRule, seedSeller } from "@/test/factories";
import { TRY_DOWN_REASON } from "@/components/try-live-link";
import { STATUS_ONLY_LABEL } from "@/components/status-only-note";

const session = { sellerId: "", addr: "addr_test1qseller" };
vi.mock("@/lib/page-auth", async () => ({
  requireSellerPage: async () => session,
  loadApiPage: async (apiId: string) => ({ session, api: await getApiForSeller(getSql(), apiId, session.sellerId) }),
  readPageSession: async () => session,
}));
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, prefetch() {} }),
  usePathname: () => "/",
}));
vi.mock("@/lib/gateway", async (orig) => ({
  ...(await orig<typeof import("@/lib/gateway")>()),
  getGateway: () => ({ getHealth: async () => ({ health: "down", checkedAt: null, lastReasons: ["getPrice: timeout"] }) }),
}));

async function liveApi(health: Health, id?: string) {
  const seller = await seedSeller();
  session.sellerId = seller.id;
  const api = await seedApi(seller.id, "live", { health, healthCheckedAt: new Date() });
  if (id) await getSql()`update apis set id = ${id} where id = ${api.id}`;
  const apiId = id ?? api.id;
  const op = await seedOperation(apiId, { enabled: true });
  await seedRule(op.id);
  await seedPack(apiId);
  return apiId;
}

const expectTryLink = (apiId: string, href = `/p/${apiId}/try`) =>
  expect(screen.getAllByRole("link", { name: "Try it live" }).map((a) => a.getAttribute("href"))).toContain(href);
const expectDisabledTry = () => {
  expect(screen.queryByRole("link", { name: "Try it live" })).toBeNull();
  const button = screen.getAllByRole("button", { name: "Try it live" })[0];
  expect(button).toBeDisabled();
  expect(button).toHaveAccessibleDescription(TRY_DOWN_REASON);
};

describe("Try it live on every live-API surface", () => {
  beforeEach(resetDb);

  it("public status page /p/[apiId]", async () => {
    const { default: Page } = await import("./p/[apiId]/page");
    const apiId = await liveApi("healthy");
    render(await Page({ params: Promise.resolve({ apiId }) }));
    expectTryLink(apiId);
  });

  it("public status page while Down: disabled with the reason", async () => {
    const { default: Page } = await import("./p/[apiId]/page");
    const apiId = await liveApi("down");
    render(await Page({ params: Promise.resolve({ apiId }) }));
    expectDisabledTry();
  });

  it("/demo", async () => {
    const { default: Page } = await import("./demo/page");
    await liveApi("healthy", DEMO_API_ID);
    render(await Page());
    expectTryLink(DEMO_API_ID);
  });

  it("seller overview: the seller's own Try it live", async () => {
    const { default: Page } = await import("./apis/[apiId]/overview/page");
    const apiId = await liveApi("healthy");
    render(await Page({ params: Promise.resolve({ apiId }) }));
    expectTryLink(apiId, `/apis/${apiId}/try`);
  });

  it("seller overview while Down", async () => {
    const { default: Page } = await import("./apis/[apiId]/overview/page");
    const apiId = await liveApi("down");
    render(await Page({ params: Promise.resolve({ apiId }) }));
    expectDisabledTry();
  });

  it("the /apis list: one per live API, none for an API still in setup", async () => {
    const { default: Page } = await import("./apis/page");
    const apiId = await liveApi("healthy");
    await seedApi(session.sellerId, "intake", { name: "Draft API" });
    render(await Page());
    expect(screen.getAllByRole("link", { name: "Try it live" }).map((a) => a.getAttribute("href"))).toEqual([`/apis/${apiId}/try`]);
  });

  it("landing hero and footer point at the demo API's try page", async () => {
    const { default: Home } = await import("./page");
    const { SiteFooter } = await import("@/components/site-footer");
    render(<><Home /><SiteFooter /></>);
    const links = screen.getAllByRole("link", { name: "Try a live API" });
    expect(links.length).toBeGreaterThanOrEqual(3);
    for (const l of links) expect(l).toHaveAttribute("href", `/p/${DEMO_API_ID}/try`);
  });
});

describe("a status-only promise is labelled for buyers", () => {
  beforeEach(resetDb);

  async function liveTextApi(id?: string) {
    const apiId = await liveApi("healthy", id);
    await getSql()`delete from rules`;
    const [op] = await getSql()<{ id: string }[]>`select id from operations where api_id = ${apiId}`;
    await seedRule(op.id, { definition: inferTextRule("text/plain", ["BTC 64000", "ETH 3100"]), plainEnglish: "A plain text answer." });
    return apiId;
  }

  it("on the public page, the try page and /demo", async () => {
    const apiId = await liveTextApi();
    const { default: PublicPage } = await import("./p/[apiId]/page");
    const { default: TryPage } = await import("./p/[apiId]/try/page");
    render(await PublicPage({ params: Promise.resolve({ apiId }) }));
    expect(screen.getByTestId("status-only")).toHaveTextContent(STATUS_ONLY_LABEL);
    cleanup();
    await resetDb();
    await liveTextApi(DEMO_API_ID);
    // The public try page has a console only for the showcase (TRY_LIVE_APIS, default the demo API).
    render(await TryPage({ params: Promise.resolve({ apiId: DEMO_API_ID }) }));
    expect(screen.getByTestId("status-only")).toHaveTextContent(STATUS_ONLY_LABEL);
    cleanup();
    const { default: Demo } = await import("./demo/page");
    render(await Demo());
    expect(screen.getByTestId("status-only")).toHaveTextContent(STATUS_ONLY_LABEL);
  });

  it("not for a JSON promise", async () => {
    const apiId = await liveApi("healthy");
    const { default: PublicPage } = await import("./p/[apiId]/page");
    render(await PublicPage({ params: Promise.resolve({ apiId }) }));
    expect(screen.queryByTestId("status-only")).toBeNull();
  });
});
