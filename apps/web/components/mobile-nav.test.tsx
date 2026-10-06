// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAuthForTests, setAuth } from "@/lib/auth-client";
import { SiteHeader } from "./site-header";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/" }));

beforeEach(() => {
  resetAuthForTests();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ signedIn: false }), { headers: { "content-type": "application/json" } })));
});
afterEach(() => vi.unstubAllGlobals());

describe("mobile nav (QA 10)", () => {
  it("is a disclosure: a Menu button that opens the section links and Log in, and Esc closes it", async () => {
    setAuth({ status: "out" });
    const user = userEvent.setup();
    render(<SiteHeader />);
    const button = screen.getByRole("button", { name: "Menu" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    const panel = document.getElementById(button.getAttribute("aria-controls")!)!;
    expect(panel).not.toBeVisible();

    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(panel).toBeVisible();
    for (const name of ["How it works", "Money", "Proof", "FAQ", "Log in"]) {
      expect(panel.querySelector(`a[href]`)).not.toBeNull();
      expect([...panel.querySelectorAll("a")].map((a) => a.textContent)).toContain(name);
    }

    await user.keyboard("{Escape}");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveFocus();
  });

  it("offers My APIs instead of Log in when signed in", async () => {
    setAuth({ status: "in", address: "addr_test1qz…000000" });
    const user = userEvent.setup();
    render(<SiteHeader />);
    const button = screen.getByRole("button", { name: "Menu" });
    await user.click(button);
    const panel = document.getElementById(button.getAttribute("aria-controls")!)!;
    const names = [...panel.querySelectorAll("a")].map((a) => a.textContent);
    expect(names).toContain("My APIs");
    expect(names).not.toContain("Log in");
  });
});
