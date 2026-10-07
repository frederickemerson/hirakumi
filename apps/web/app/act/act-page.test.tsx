// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashActToken, newActToken, newId, type ActAction } from "@hirakumi/core";
import { getSql } from "@/lib/db";
import type { Seller } from "@/lib/types";
import { resetDb } from "@/test/db";
import { seedApi, seedOnboardStep, seedPack, seedSeller } from "@/test/factories";
import ActPage from "./[token]/page";

vi.mock("@utxos/sdk", () => ({ Web3Wallet: { enable: vi.fn() } }));

let seller: Seller;
beforeEach(async () => {
  await resetDb();
  seller = await seedSeller("addr_test1qqactpage000000000000000000000000abc123");
});

async function link(apiId: string, action: ActAction, expired = false): Promise<string> {
  const token = newActToken();
  await getSql()`
    insert into act_tokens (id, token_hash, api_id, action, wallet, expires_at)
    values (${newId("act")}, ${hashActToken(token)}, ${apiId}, ${action}, ${seller.cardanoAddr},
            ${expired ? getSql()`now() - interval '1 minute'` : getSql()`now() + interval '30 minutes'`})`;
  return token;
}
const page = async (token: string) => render(await ActPage({ params: Promise.resolve({ token }) }));

describe("/act/<token>: one wallet step, nothing else", () => {
  it("ownership: says what is signed and with which wallet, with the key field the OpenAPI file asks for", async () => {
    const api = await seedApi(seller.id, "endpoints_confirmed", { origin: "https://weather.example.com" });
    await seedOnboardStep(api.id, "parse", "done", { authHint: { in: "header", name: "X-API-Key" } });
    await page(await link(api.id, "ownership"));
    expect(screen.getByRole("heading", { name: "Sign to prove you own weather.example.com" })).toBeInTheDocument();
    expect(screen.getByText("…abc123")).toBeInTheDocument();
    expect(screen.getByDisplayValue("X-API-Key")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull(); // nothing to navigate to
  });

  it("publish: names the price", async () => {
    const api = await seedApi(seller.id, "priced", { origin: "https://weather.example.com" });
    await seedPack(api.id, { calls: 100, priceMicros: "2000000" });
    await page(await link(api.id, "publish"));
    expect(screen.getByRole("heading", { name: "Sign to publish weather.example.com at 2 tUSDM for 100 calls" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Key/)).toBeNull();
  });

  it("an expired, unknown or out-of-step link says what to do, with no wallet buttons", async () => {
    const api = await seedApi(seller.id, "priced");
    await page(await link(api.id, "publish", true));
    expect(screen.getByRole("alert")).toHaveTextContent("This link expired. Reply in your Sokosumi task and Hirakumi sends a new one.");
    screen.getByRole("alert").remove();
    await page(newActToken());
    expect(screen.getByRole("alert")).toHaveTextContent("This link isn't valid.");
    screen.getByRole("alert").remove();
    await page(await link(api.id, "ownership"));
    expect(screen.getByRole("alert")).toHaveTextContent("isn't at any more");
  });
});
