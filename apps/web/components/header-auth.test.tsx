// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAuthForTests } from "@/lib/auth-client";
import { jsonResponse } from "@/test/http";
import { HeaderAuth } from "./header-auth";
import { SessionSeed } from "./session-seed";

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), pathname: "/" }));
vi.mock("next/navigation", () => ({ useRouter: () => nav, usePathname: () => nav.pathname }));

const SHORT = "addr_test1qz…tuqq5x";
const CHIP = `Account ${SHORT}`;

function stubFetch(me: object, logout: () => Response = () => new Response(null, { status: 303, headers: { location: "/login" } })) {
  const f = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url === "/api/auth/me") return jsonResponse(me);
    if (url === "/api/auth/logout") return logout();
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", f);
  return f;
}

async function renderSignedIn() {
  const f = stubFetch({ signedIn: true, address: SHORT });
  const view = render(<HeaderAuth />);
  await screen.findByRole("link", { name: "My APIs" });
  return { f, ...view };
}

beforeEach(() => {
  resetAuthForTests();
  nav.pathname = "/";
});
afterEach(() => {
  vi.unstubAllGlobals();
  nav.push.mockReset();
  nav.refresh.mockReset();
});

describe("HeaderAuth", () => {
  it("shows the signed-out buttons by default and after a signed-out probe", async () => {
    const f = stubFetch({ signedIn: false });
    render(<HeaderAuth />);
    expect(screen.getByRole("link", { name: "Log in" })).toHaveAttribute("href", "/login");
    expect(screen.getByRole("link", { name: "List your API" })).toHaveAttribute("href", "/login");
    await waitFor(() => expect(f).toHaveBeenCalledWith("/api/auth/me", expect.objectContaining({ cache: "no-store" })));
    expect(screen.getByRole("link", { name: "List your API" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "My APIs" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Account/ })).toBeNull();
  });

  it("swaps to My APIs and the account chip once the probe says signed in", async () => {
    await renderSignedIn();
    expect(screen.getByRole("link", { name: "My APIs" })).toHaveAttribute("href", "/apis");
    expect(screen.getByRole("button", { name: CHIP })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "Log in" })).toBeNull();
    expect(screen.queryByRole("link", { name: "List your API" })).toBeNull();
  });

  it("keeps both states in one grid cell so the swap never shifts the layout", async () => {
    const { container } = await renderSignedIn();
    const out = container.querySelector('[data-auth-layer="out"]')!;
    const inn = container.querySelector('[data-auth-layer="in"]')!;
    expect(out).toHaveAttribute("aria-hidden", "true");
    expect(out.hasAttribute("inert")).toBe(true);
    expect(inn).not.toHaveAttribute("aria-hidden");
    for (const layer of [out, inn]) expect(layer.className).toMatch(/col-start-1 row-start-1/);
  });

  it("shows the signed-in header on seller pages straight away, without a probe", () => {
    nav.pathname = "/apis/api_1/overview";
    const f = stubFetch({ signedIn: false });
    render(
      <>
        <HeaderAuth />
        <SessionSeed address={SHORT} />
      </>,
    );
    expect(screen.getByRole("link", { name: "My APIs" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: CHIP })).toBeInTheDocument();
    expect(f).not.toHaveBeenCalled();
  });

  it("never flashes Log in on a seller page while the session is still unknown", () => {
    nav.pathname = "/apis";
    stubFetch({ signedIn: true, address: SHORT });
    render(<HeaderAuth />);
    expect(screen.queryByRole("link", { name: "Log in" })).toBeNull();
  });
});

describe("account menu", () => {
  it("opens from the chip, moves with the arrow keys, and Esc returns focus to the chip", async () => {
    const user = userEvent.setup();
    await renderSignedIn();
    const chip = screen.getByRole("button", { name: CHIP });
    chip.focus();
    await user.keyboard("{Enter}");
    expect(chip).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("menu", { name: "Account" });
    expect(chip).toHaveAttribute("aria-controls", menu.id);
    const items = screen.getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["My APIs", "List a new API", "Log out"]);
    expect(items[0]).toHaveAttribute("href", "/apis");
    expect(items[1]).toHaveAttribute("href", "/apis/new");
    expect(items[0]).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(items[1]).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(items[0]).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(items[2]).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(chip).toHaveFocus();
  });

  it("opens with ArrowDown and closes on a click outside", async () => {
    const user = userEvent.setup();
    await renderSignedIn();
    const chip = screen.getByRole("button", { name: CHIP });
    chip.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getAllByRole("menuitem")[0]).toHaveFocus();
    await user.click(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("logs out with a same-origin POST, goes home and shows the signed-out header", async () => {
    const user = userEvent.setup();
    const { f } = await renderSignedIn();
    await user.click(screen.getByRole("button", { name: CHIP }));
    await user.click(screen.getByRole("menuitem", { name: "Log out" }));
    const call = f.mock.calls.find((c) => c[0] === "/api/auth/logout")!;
    expect(call[1]).toMatchObject({ method: "POST", credentials: "same-origin", redirect: "manual" });
    await screen.findByRole("link", { name: "Log in" });
    expect(screen.queryByRole("link", { name: "My APIs" })).toBeNull();
    expect(nav.push).toHaveBeenCalledWith("/");
    expect(nav.refresh).toHaveBeenCalled();
  });

  it("stays signed in and says so when logout is refused", async () => {
    const user = userEvent.setup();
    stubFetch({ signedIn: true, address: SHORT }, () => jsonResponse({ error: "Cross-site request refused." }, 403));
    render(<HeaderAuth />);
    await user.click(await screen.findByRole("button", { name: CHIP }));
    await user.click(screen.getByRole("menuitem", { name: "Log out" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't log out. Try again.");
    expect(screen.getByRole("link", { name: "My APIs" })).toBeInTheDocument();
    expect(nav.push).not.toHaveBeenCalled();
  });
});
