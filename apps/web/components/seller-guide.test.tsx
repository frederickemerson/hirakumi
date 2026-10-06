// @vitest-environment jsdom
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GUIDE } from "@/lib/guide";
import { PROGRESS_EVENT, progressFor } from "@/lib/progress";
import { buildTimeline } from "@/lib/timeline";
import type { ApiState } from "@/lib/types";
import { jsonResponse } from "@/test/http";
import { SellerGuide } from "./seller-guide";

const nav = vi.hoisted(() => ({ pathname: "/apis/api_1/ownership" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

const progress = (state: ApiState) => progressFor({ id: "api_1", state }, buildTimeline(state, []), null);

afterEach(() => vi.unstubAllGlobals());

describe("SellerGuide", () => {
  it("explains the current step as messages from Hirakumi, with its questions", () => {
    render(<SellerGuide apiId="api_1" initial={progress("endpoints_confirmed")} chatEnabled={false} />);
    const guide = screen.getByRole("complementary", { name: "Hirakumi guide" });
    expect(within(guide).getByText(GUIDE.ownership.now)).toBeInTheDocument();
    expect(within(guide).getByText("Signing costs nothing and moves no funds.")).toBeInTheDocument();
    expect(within(guide).getByText("Why do you need my wallet?")).toBeInTheDocument();
    // No chat box when the chat is turned off.
    expect(within(guide).queryByLabelText("Ask Hirakumi a question")).toBeNull();
  });

  it("opens as a sheet from the help button and closes with Escape, the close button or the backdrop", async () => {
    const user = userEvent.setup();
    render(<SellerGuide apiId="api_1" initial={progress("endpoints_confirmed")} chatEnabled={false} />);
    const help = screen.getByRole("button", { name: "Need help?" });
    expect(help).toHaveAttribute("aria-expanded", "false");

    await user.click(help);
    const sheet = screen.getByRole("dialog", { name: "Hirakumi guide" });
    expect(sheet).toHaveAttribute("data-open");
    expect(sheet).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: "Close guide" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("complementary", { name: "Hirakumi guide" })).not.toHaveAttribute("data-open");
    expect(help).toHaveFocus();

    await user.click(help);
    await user.click(screen.getByRole("button", { name: "Close guide" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("moves to the next step live when the waiting screen's poller reports progress", async () => {
    render(<SellerGuide apiId="api_1" initial={progress("ownership_verified")} chatEnabled={false} />);
    expect(screen.getByText(GUIDE.test.now)).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new CustomEvent(PROGRESS_EVENT, { detail: progress("rule_built") }));
    });
    expect(await screen.findByText(GUIDE.price.now)).toBeInTheDocument();
    // The previous step stays above, so the seller can see what just happened.
    expect(screen.getByText(GUIDE.test.now)).toBeInTheDocument();
    // Another API's progress is ignored.
    act(() => {
      window.dispatchEvent(new CustomEvent(PROGRESS_EVENT, { detail: progressFor({ id: "api_2", state: "live" }, buildTimeline("live", []), null) }));
    });
    expect(screen.queryByText(GUIDE.live.now)).toBeNull();
  });

  it("greets a seller who has not pasted a link yet", () => {
    render(<SellerGuide apiId={null} initial={null} chatEnabled={false} />);
    expect(screen.getByText(GUIDE.paste.now)).toBeInTheDocument();
  });
});

describe("SellerGuide chat", () => {
  it("loads the conversation for this API and shows who said what", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ messages: [
      { id: "1", apiId: "api_1", author: "seller", body: "Hello", createdAt: "2026-10-06T10:00:00Z" },
      { id: "2", apiId: "api_1", author: "coworker", body: "Found 6 endpoints, 2 look sellable.", createdAt: "2026-10-06T10:00:05Z" },
    ] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<SellerGuide apiId="api_1" initial={progress("described")} chatEnabled />);
    expect(await screen.findByText("Found 6 endpoints, 2 look sellable.")).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/chat?after=0&apiId=api_1");
    expect(screen.getByText("You:")).toBeInTheDocument();
    expect(screen.getByText("Hirakumi coworker:")).toBeInTheDocument();
  });

  it("shows a question at once and sends it through the existing chat API", async () => {
    let resolvePost: (r: Response) => void = () => {};
    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? new Promise<Response>((r) => { resolvePost = r; })
        : Promise.resolve(jsonResponse({ messages: [] })));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<SellerGuide apiId="api_1" initial={progress("described")} chatEnabled />);
    await user.type(screen.getByLabelText("Ask Hirakumi a question"), "Help");
    await user.click(screen.getByRole("button", { name: "Send" }));
    // Optimistic: visible before the server answers, and the box is cleared.
    expect(screen.getByText("Help")).toBeInTheDocument();
    expect(screen.getByLabelText("Ask Hirakumi a question")).toHaveValue("");
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(post[1]!.body as string)).toEqual({ apiId: "api_1", body: "Help" });
    await act(async () => resolvePost(jsonResponse({ message: { id: "9", apiId: "api_1", author: "seller", body: "Help", createdAt: "2026-10-06T10:00:00Z" } }, 201)));
    expect(screen.getAllByText("Help")).toHaveLength(1);
  });

  it("puts the question back in the box when it could not be sent", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) =>
      Promise.resolve(init?.method === "POST" ? jsonResponse({ error: "Keep messages under 4,000 characters." }, 400) : jsonResponse({ messages: [] }))));
    const user = userEvent.setup();
    render(<SellerGuide apiId="api_1" initial={progress("described")} chatEnabled />);
    await user.type(screen.getByLabelText("Ask Hirakumi a question"), "Help{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Keep messages under 4,000 characters.");
    expect(screen.getByLabelText("Ask Hirakumi a question")).toHaveValue("Help");
  });

  it("says when messages can't be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    render(<SellerGuide apiId={null} initial={null} chatEnabled />);
    expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't load messages. Retrying…");
  });
});
