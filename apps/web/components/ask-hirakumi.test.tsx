// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_QUESTION_CHARS, SUGGESTED_QUESTIONS } from "@/lib/ask/shared";
import { jsonResponse } from "@/test/http";
import { ASK_STORAGE_KEY, AskHirakumi } from "./ask-hirakumi";

/** A streamed text response the test feeds chunk by chunk. */
function controlledStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
  const encoder = new TextEncoder();
  return {
    response: new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } }),
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
  };
}

const textResponse = (text: string) => new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.unstubAllGlobals());

async function openPanel() {
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Ask Hirakumi" });
  await user.click(trigger);
  return { user, trigger, panel: screen.getByRole("dialog", { name: "Ask Hirakumi" }) };
}

describe("AskHirakumi", () => {
  it("starts closed: one floating button with the logo mark, and no dialog", () => {
    render(<AskHirakumi />);
    const trigger = screen.getByRole("button", { name: "Ask Hirakumi" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger.querySelector("svg")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens a modal panel with the question box focused, and closes with Escape, returning focus", async () => {
    render(<AskHirakumi />);
    const { user, trigger, panel } = await openPanel();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(panel).toHaveAttribute("aria-modal", "true");
    expect(panel).toHaveAttribute("data-open");
    expect(screen.getByRole("textbox", { name: "Your question" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("closes from the close button and from the backdrop", async () => {
    render(<AskHirakumi />);
    const { user, trigger } = await openPanel();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    await user.click(document.querySelector<HTMLElement>("[data-ask-scrim]")!);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps Tab focus inside the panel while it is open", async () => {
    render(<AskHirakumi />);
    const { user, panel } = await openPanel();
    for (let i = 0; i < 12; i++) {
      await user.tab();
      expect(panel.contains(document.activeElement)).toBe(true);
    }
    for (let i = 0; i < 12; i++) {
      await user.tab({ shift: true });
      expect(panel.contains(document.activeElement)).toBe(true);
    }
  });

  it("offers the suggested questions, and a chip sends its question and streams the answer in", async () => {
    const stream = controlledStream();
    const fetchMock = vi.fn().mockResolvedValue(stream.response);
    vi.stubGlobal("fetch", fetchMock);
    render(<AskHirakumi />);
    const { user, panel } = await openPanel();
    for (const q of SUGGESTED_QUESTIONS) expect(within(panel).getByRole("button", { name: q })).toBeInTheDocument();

    await user.click(within(panel).getByRole("button", { name: "Is my money safe?" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/ask", expect.objectContaining({ method: "POST" }));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ question: "Is my money safe?", history: [] });

    const log = within(panel).getByRole("log");
    expect(log).toHaveAttribute("aria-live", "polite");
    expect(within(log).getByText("Is my money safe?")).toBeInTheDocument();
    // The chips make way for the conversation.
    expect(within(panel).queryByRole("button", { name: "What does an agent pay?" })).toBeNull();

    await act(async () => stream.push("Pack payments settle "));
    expect(await within(log).findByText("Pack payments settle")).toBeInTheDocument();
    await act(async () => {
      stream.push("to your wallet.");
      stream.end();
    });
    expect(await within(log).findByText("Pack payments settle to your wallet.")).toBeInTheDocument();
    // Finished: the answer is no longer marked busy.
    await waitFor(() => expect(log.querySelector("[aria-busy]")).toBeNull());
  });

  it("sends a typed question with Enter, with the earlier conversation as history", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(textResponse("First answer."))
      .mockResolvedValueOnce(textResponse("Second answer."));
    vi.stubGlobal("fetch", fetchMock);
    render(<AskHirakumi />);
    const { user } = await openPanel();
    const box = screen.getByRole("textbox", { name: "Your question" });
    expect(box).toHaveAttribute("maxLength", String(MAX_QUESTION_CHARS));

    await user.type(box, "What is a promise?{Enter}");
    expect(await screen.findByText("First answer.")).toBeInTheDocument();
    expect(box).toHaveValue("");

    await user.type(box, "And if it breaks?{Enter}");
    expect(await screen.findByText("Second answer.")).toBeInTheDocument();
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      question: "And if it breaks?",
      history: [
        { role: "user", content: "What is a promise?" },
        { role: "assistant", content: "First answer." },
      ],
    });
  });

  it("turns the questions an answer lists into chips, and site paths into links", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(textResponse(
        "I can't answer open questions right now, sorry. I can still answer these: How do I list my API? Do I need a wallet? The home page FAQ covers more, and /p/api_eejiaioyqt/try lets you try a live API.",
      ))
      .mockResolvedValueOnce(textResponse("Yes, a CIP-30 wallet."));
    vi.stubGlobal("fetch", fetchMock);
    render(<AskHirakumi />);
    const { user, panel } = await openPanel();
    await user.type(screen.getByRole("textbox", { name: "Your question" }), "Write me a poem{Enter}");
    const log = within(panel).getByRole("log");
    expect(await within(log).findByRole("link", { name: "/p/api_eejiaioyqt/try" })).toHaveAttribute("href", "/p/api_eejiaioyqt/try");
    expect(within(log).getByRole("button", { name: "How do I list my API?" })).toBeInTheDocument();
    await user.click(within(log).getByRole("button", { name: "Do I need a wallet?" }));
    expect(await within(log).findByText("Yes, a CIP-30 wallet.")).toBeInTheDocument();
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(init.body as string).question).toBe("Do I need a wallet?");
  });

  it("lets the panel subtitle wrap on a narrow screen", async () => {
    render(<AskHirakumi />);
    const { panel } = await openPanel();
    expect(within(panel).getByText("Answers about selling your API to agents")).not.toHaveClass("truncate");
  });

  it("shows the server's message when a question is refused", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "That's a lot of questions at once." }, 429)));
    render(<AskHirakumi />);
    const { user } = await openPanel();
    await user.click(screen.getByRole("button", { name: "How do I list my API?" }));
    expect(await screen.findByText("That's a lot of questions at once.")).toBeInTheDocument();
  });

  it("keeps the conversation for the session, across a remount, and can start over", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse("Any CIP-30 wallet works.")));
    const first = render(<AskHirakumi />);
    const { user } = await openPanel();
    await user.click(screen.getByRole("button", { name: "Why do you need my wallet?" }));
    expect(await screen.findByText("Any CIP-30 wallet works.")).toBeInTheDocument();
    await waitFor(() => expect(sessionStorage.getItem(ASK_STORAGE_KEY)).toContain("Any CIP-30 wallet works."));
    first.unmount();

    render(<AskHirakumi />);
    const again = await openPanel();
    expect(within(again.panel).getByText("Any CIP-30 wallet works.")).toBeInTheDocument();

    await again.user.click(screen.getByRole("button", { name: "New chat" }));
    expect(within(again.panel).queryByText("Any CIP-30 wallet works.")).toBeNull();
    expect(within(again.panel).getByRole("button", { name: "How do I list my API?" })).toBeInTheDocument();
    expect(JSON.parse(sessionStorage.getItem(ASK_STORAGE_KEY) ?? "[]")).toEqual([]);
  });
});
