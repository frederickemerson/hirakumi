// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSql } from "@/lib/db";
import { createSessionToken } from "@/lib/session";
import type { Seller } from "@/lib/types";
import { resetDb } from "@/test/db";
import { seedSeller } from "@/test/factories";
import SokosumiSetupPage from "./page";

const jar = vi.hoisted(() => ({ token: null as string | null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "hk_session" && jar.token ? { value: jar.token } : undefined) }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));

let me: Seller;
beforeEach(async () => {
  await resetDb();
  await getSql()`delete from coworker_tasks`; // hangs off no seller, so resetDb leaves it
  me =await seedSeller("addr_test1qqsetuppage00000000000000005vxkj4");
  jar.token = createSessionToken(me.id, me.cardanoAddr);
  await getSql()`insert into coworker_tasks (task_id, sokosumi_user_id, task_name, setup_token)
                 values ('tsk_1', 'usr_soko_1', 'Put my API on the agent market', 'tok_1')`;
});
const page = async (q: { t?: string; link?: string }) => render(await SokosumiSetupPage({ searchParams: Promise.resolve(q) }));
const linkTo = (user: string, sellerId: string) => getSql()`update sellers set sokosumi_user_id = ${user} where id = ${sellerId}`;

describe("/setup and the Sokosumi link", () => {
  it("unlinked: says what the submit links, with the form", async () => {
    await page({ t: "tok_1" });
    expect(screen.getByTestId("sokosumi-link-notice")).toHaveTextContent("addr_test1qq…5vxkj4");
    expect(screen.getByLabelText("OpenAPI link")).toBeInTheDocument();
  });

  it("linked to another wallet: the move panel instead of the form", async () => {
    const other = await seedSeller("addr_test1qqotherwallet0000000000000000abc123");
    await linkTo("usr_soko_1", other.id);
    await page({ t: "tok_1" });
    expect(screen.getByTestId("sokosumi-move")).toHaveTextContent("linked to wallet addr_test1qq…abc123");
    expect(screen.getByTestId("sokosumi-move")).toHaveTextContent("Move it to this wallet (addr_test1qq…5vxkj4)?");
    expect(screen.queryByLabelText("OpenAPI link")).toBeNull();
  });

  it("this wallet holds another Sokosumi account: points to Account settings", async () => {
    await linkTo("usr_other", me.id);
    await page({ t: "tok_1" });
    expect(screen.getByTestId("sokosumi-link-conflict")).toBeInTheDocument();
    expect(screen.queryByLabelText("OpenAPI link")).toBeNull();
  });

  it("&link=1, already linked here: says so, no form", async () => {
    await linkTo("usr_soko_1", me.id);
    await page({ t: "tok_1", link: "1" });
    expect(screen.getByTestId("sokosumi-linked-here")).toBeInTheDocument();
    expect(screen.queryByLabelText("OpenAPI link")).toBeNull();
  });

  it("&link=1, linked elsewhere: the move panel, no form", async () => {
    const other = await seedSeller();
    await linkTo("usr_soko_1", other.id);
    await page({ t: "tok_1", link: "1" });
    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument();
    expect(screen.queryByLabelText("OpenAPI link")).toBeNull();
  });

  it("&link=1, not linked: a link panel with Confirm, no form", async () => {
    await page({ t: "tok_1", link: "1" });
    expect(screen.getByTestId("sokosumi-move")).toHaveTextContent("Link your Sokosumi account");
    expect(screen.queryByLabelText("OpenAPI link")).toBeNull();
  });

  it("signed out: the wallet sign-in is on this page (no separate login page), and comes back to the same link", async () => {
    jar.token = null;
    await page({ t: "tok_1", link: "1" });
    expect(screen.getByRole("heading", { name: "Link your Sokosumi account" })).toBeInTheDocument();
    expect(screen.getByText("Sign in with your Cardano wallet. It costs nothing and moves no funds.")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Looking for wallets" })).toBeInTheDocument();
    expect(screen.queryByTestId("sokosumi-move")).toBeNull();
  });

  it("&link=1, already linked here: says the tab can close, the rest is in Sokosumi", async () => {
    await linkTo("usr_soko_1", me.id);
    await page({ t: "tok_1", link: "1" });
    expect(screen.getByTestId("sokosumi-linked-here")).toHaveTextContent("Done. You can close this tab; the rest continues in Sokosumi.");
  });

  it("an unknown setup token says so", async () => {
    await page({ t: "nope", link: "1" });
    expect(screen.getByText(/isn't valid any more/)).toBeInTheDocument();
  });
});
