// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "@/test/http";
import { ChatPanel } from "./chat-panel";

afterEach(() => vi.unstubAllGlobals());

describe("ChatPanel", () => {
  it("shows the empty state, then the conversation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ messages: [] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ChatPanel apiId="api_1" />);
    expect(await screen.findByText("Ask the Hirakumi coworker anything about listing your API. Replies appear here.")).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/chat?after=0&apiId=api_1");
  });

  it("renders who said what", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ messages: [
      { id: "1", apiId: "api_1", author: "seller", body: "Hello", createdAt: "2026-10-06T10:00:00Z" },
      { id: "2", apiId: "api_1", author: "coworker", body: "Found 6 endpoints, 2 look sellable.", createdAt: "2026-10-06T10:00:05Z" },
    ] })));
    render(<ChatPanel apiId="api_1" />);
    expect(await screen.findByText("Found 6 endpoints, 2 look sellable.")).toBeInTheDocument();
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.getByText("Hirakumi coworker")).toBeInTheDocument();
  });

  it("sends a message and shows it", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? jsonResponse({ message: { id: "9", apiId: "api_1", author: "seller", body: "Help", createdAt: "2026-10-06T10:00:00Z" } }, 201)
        : jsonResponse({ messages: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ChatPanel apiId="api_1" />);
    await user.type(screen.getByLabelText("Message"), "Help");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Help")).toBeInTheDocument();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(post[1]!.body as string)).toEqual({ apiId: "api_1", body: "Help" });
  });

  it("says when messages can't be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    render(<ChatPanel apiId={null} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't load messages. Retrying…");
  });
});
