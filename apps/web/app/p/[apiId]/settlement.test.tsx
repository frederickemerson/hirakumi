// @vitest-environment jsdom
/** The public API page says how the pack settles and why (gateway PACK_MODE and settlement policy). */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PackSettlement } from "@/lib/settlement";
import { resetDb } from "@/test/db";
import { seedApi, seedOperation, seedPack, seedRule, seedSeller } from "@/test/factories";

const answer: { packs: PackSettlement[] | Error } = { packs: [] };
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, prefetch() {} }),
  usePathname: () => "/",
}));
vi.mock("@/lib/gateway", async (orig) => ({
  ...(await orig<typeof import("@/lib/gateway")>()),
  getGateway: () => ({
    getSettlement: async () => { if (answer.packs instanceof Error) throw answer.packs; return answer.packs; },
  }),
}));

async function liveApi() {
  const seller = await seedSeller();
  const api = await seedApi(seller.id, "live", { health: "healthy", healthCheckedAt: new Date() });
  const op = await seedOperation(api.id, { enabled: true });
  await seedRule(op.id);
  const pack = await seedPack(api.id);
  return { apiId: api.id, packId: pack.id };
}

describe("public API page settlement line", () => {
  beforeEach(resetDb);

  it("shows the mode and the reasons for the pack", async () => {
    const { default: Page } = await import("./page");
    const { apiId, packId } = await liveApi();
    answer.packs = [{ packId, mode: "escrow", reasons: ["new seller"] }];
    render(await Page({ params: Promise.resolve({ apiId }) }));
    expect(screen.getByTestId("settlement")).toHaveTextContent("Settlement: escrow, because: new seller");
  });

  it("leaves the line out when the gateway can't answer", async () => {
    const { default: Page } = await import("./page");
    const { apiId } = await liveApi();
    answer.packs = new Error("unreachable");
    render(await Page({ params: Promise.resolve({ apiId }) }));
    expect(screen.queryByTestId("settlement")).toBeNull();
  });
});
