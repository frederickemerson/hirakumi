// @vitest-environment jsdom
/**
 * Try it live is a tool for sellers. The public try page has a console only for the showcase (TRY_LIVE_APIS);
 * any other API shows buyers how to pay and links its owner to the dashboard. The seller's page says who pays.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSql } from "@/lib/db";
import { DEMO_API_ID } from "@/lib/demo";
import { getApiForSeller } from "@/lib/repo/apis";
import { resetDb } from "@/test/db";
import { seedApi, seedOperation, seedPack, seedRule, seedSeller } from "@/test/factories";
import { jsonRequest, ctx } from "@/test/requests";
import { SELF_PAY_LINE } from "@/components/wallet-pay";

const session = { sellerId: "", addr: "addr_test1qseller" };
let signedIn = true;
vi.mock("@/lib/page-auth", async () => ({
  requireSellerPage: async () => session,
  loadApiPage: async (apiId: string) => ({ session, api: await getApiForSeller(getSql(), apiId, session.sellerId) }),
  readPageSession: async () => (signedIn ? session : null),
}));
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, prefetch() {} }),
  usePathname: () => "/",
}));

async function liveApi(id?: string) {
  const seller = await seedSeller();
  session.sellerId = seller.id;
  const api = await seedApi(seller.id, "live", { healthCheckedAt: new Date() });
  if (id) await getSql()`update apis set id = ${id} where id = ${api.id}`;
  const apiId = id ?? api.id;
  const op = await seedOperation(apiId, { enabled: true });
  await seedRule(op.id);
  await seedPack(apiId);
  return apiId;
}

describe("public Try it live", () => {
  beforeEach(async () => {
    await resetDb();
    signedIn = true;
  });

  it("the showcase API keeps its console and the demo wallet's buy button", async () => {
    const { default: TryPage } = await import("./p/[apiId]/try/page");
    await liveApi(DEMO_API_ID);
    render(await TryPage({ params: Promise.resolve({ apiId: DEMO_API_ID }) }));
    expect(screen.getByRole("button", { name: "Buy a pack live" })).toBeInTheDocument();
    expect(screen.queryByTestId("buy-your-own")).toBeNull();
  });

  it("any other API: no buy button, how buyers pay, and for its owner a link to the dashboard", async () => {
    const { default: TryPage } = await import("./p/[apiId]/try/page");
    const apiId = await liveApi();
    render(await TryPage({ params: Promise.resolve({ apiId }) }));
    expect(screen.queryByRole("button", { name: "Buy a pack live" })).toBeNull();
    expect(screen.getByTestId("buy-your-own")).toHaveTextContent(/own wallet over x402/);
    expect(screen.getByRole("link", { name: "See the buyer code" })).toHaveAttribute("href", `/p/${apiId}#buyer-snippet`);
    expect(screen.getByRole("link", { name: "Test it from your dashboard" })).toHaveAttribute("href", `/apis/${apiId}/try`);
  });

  it("a visitor who isn't the owner gets no dashboard link", async () => {
    const { default: TryPage } = await import("./p/[apiId]/try/page");
    const apiId = await liveApi();
    signedIn = false;
    render(await TryPage({ params: Promise.resolve({ apiId }) }));
    expect(screen.queryByRole("link", { name: "Test it from your dashboard" })).toBeNull();
  });

  it("the public call and receipts routes refuse a non-showcase API before any lookup", async () => {
    const { POST } = await import("./api/try/[apiId]/route");
    const { GET } = await import("./api/try/[apiId]/receipts/route");
    const apiId = await liveApi();
    const call = await POST(jsonRequest(`/api/try/${apiId}`, { body: { opId: "getPrice", method: "GET", input: {} } }), ctx(apiId));
    expect(call.status).toBe(404);
    expect((await GET(jsonRequest(`/api/try/${apiId}/receipts`), ctx(apiId))).status).toBe(404);
  });
});

describe("the seller's Try it live page", () => {
  beforeEach(resetDb);

  it("first test free: says Hirakumi pays and offers the free pack", async () => {
    const { default: Page } = await import("./apis/[apiId]/try/page");
    const apiId = await liveApi();
    render(await Page({ params: Promise.resolve({ apiId }) }));
    expect(screen.getByTestId("who-pays")).toHaveTextContent(/first test is free/);
    expect(screen.getByTestId("who-pays")).toHaveTextContent("3 free tests left");
    expect(screen.getByRole("button", { name: "Buy a pack live" })).toBeInTheDocument();
  });

  it("free test used: the seller's wallet pays, and the page says where the money goes", async () => {
    const { default: Page } = await import("./apis/[apiId]/try/page");
    const apiId = await liveApi();
    await getSql()`insert into try_tokens (id, api_id, status, self_test_seller_id) values ('try_used', ${apiId}, 'failed', ${session.sellerId})`;
    render(await Page({ params: Promise.resolve({ apiId }) }));
    expect(screen.getByTestId("who-pays")).toHaveTextContent(SELF_PAY_LINE);
    expect(screen.queryByRole("button", { name: "Buy a pack live" })).toBeNull();
    expect(screen.getByTestId("wallet-pay")).toHaveTextContent(/Pay with your wallet/);
  });

  it("an API that isn't live yet: nothing to try", async () => {
    const { default: Page } = await import("./apis/[apiId]/try/page");
    const seller = await seedSeller();
    session.sellerId = seller.id;
    const api = await seedApi(seller.id, "priced");
    render(await Page({ params: Promise.resolve({ apiId: api.id }) }));
    expect(screen.getByText("Try it live opens once your API is live.")).toBeInTheDocument();
  });
});
