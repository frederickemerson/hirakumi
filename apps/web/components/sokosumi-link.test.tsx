// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "@/test/http";
import { MoveSokosumiPanel, SokosumiAccountLink, SokosumiLinkNotice } from "./sokosumi-link";

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));

afterEach(() => {
  vi.unstubAllGlobals();
  nav.refresh.mockReset();
});

const FROM = "addr_test1qqoldwallet00000000000000000000abc123";
const TO = "addr_test1qqnewwallet000000000000000000005vxkj4";

describe("SokosumiLinkNotice", () => {
  it("says plainly what the submit links, and to which wallet", () => {
    render(<SokosumiLinkNotice address={TO} />);
    const notice = screen.getByTestId("sokosumi-link-notice");
    expect(notice).toHaveTextContent("This links your Sokosumi account to this wallet (addr_test1qq…5vxkj4). Listings from your Sokosumi tasks will belong to it.");
    expect(notice.textContent).not.toMatch(/[–—]/);
  });
});

describe("MoveSokosumiPanel", () => {
  it("names both wallets and moves only on Confirm", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ linked: true, already: false, moved: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<MoveSokosumiPanel setupToken="tok_1" from={FROM} to={TO} />);
    const panel = screen.getByTestId("sokosumi-move");
    expect(panel).toHaveTextContent("Move your Sokosumi account");
    expect(panel).toHaveTextContent(
      "Your Sokosumi account is linked to wallet addr_test1qq…abc123. Move it to this wallet (addr_test1qq…5vxkj4)? Listings from your Sokosumi tasks that are not live yet move with it.");
    expect(panel.textContent).not.toMatch(/[–—]/);
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await screen.findByTestId("sokosumi-moved");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/sokosumi/link");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ setupToken: "tok_1" });
    expect(screen.getByTestId("sokosumi-moved")).toHaveTextContent("Your Sokosumi account now uses this wallet (addr_test1qq…5vxkj4).");
    expect(nav.refresh).toHaveBeenCalled();
  });

  it("without a current wallet, offers to link", () => {
    render(<MoveSokosumiPanel setupToken="tok_1" from={null} to={TO} />);
    expect(screen.getByTestId("sokosumi-move")).toHaveTextContent("Link your Sokosumi account");
    expect(screen.getByTestId("sokosumi-move")).toHaveTextContent("This links your Sokosumi account to this wallet (addr_test1qq…5vxkj4).");
  });

  it("shows the server's refusal", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ error: "This wallet is already linked to another Sokosumi account." }, 409)));
    const user = userEvent.setup();
    render(<MoveSokosumiPanel setupToken="tok_1" from={FROM} to={TO} />);
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("This wallet is already linked to another Sokosumi account.")).toBeInTheDocument();
    expect(screen.queryByTestId("sokosumi-moved")).toBeNull();
  });
});

describe("SokosumiAccountLink", () => {
  it("shows Linked with Unlink, and Not linked after unlinking", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ linked: false, changed: true }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<SokosumiAccountLink linked />);
    expect(screen.getByText("Linked")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Unlink" }));
    expect(await screen.findByText("Not linked")).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/sokosumi/unlink");
    expect(screen.queryByRole("button", { name: "Unlink" })).toBeNull();
  });

  it("not linked: no Unlink button", () => {
    render(<SokosumiAccountLink linked={false} />);
    expect(screen.getByText("Not linked")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
