"use client";

import { ArrowUp, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Mascot } from "@/components/brand/mascot";
import { MAX_HISTORY_MESSAGES, MAX_QUESTION_CHARS, SUGGESTED_QUESTIONS, type AskRole, type AskTurn } from "@/lib/ask/shared";
import { cn } from "@/lib/utils";

/** Where the conversation is kept for the browser tab (sessionStorage), so it survives reloads and full navigations. */
export const ASK_STORAGE_KEY = "hirakumi.ask.v1";
/** Messages kept in storage and on screen. */
const MAX_KEPT = 40;

type Message = { id: string; role: AskRole; content: string; status: "streaming" | "done" | "error" };

const OFFLINE = "We couldn't reach Hirakumi. Check your connection and try again.";
const FAILED = "Something went wrong. Please try again.";

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

let nextId = 0;
const newId = () => `m${Date.now().toString(36)}${(nextId++).toString(36)}`;

function loadMessages(): Message[] {
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(ASK_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (m): m is Message =>
        !!m && typeof m.id === "string" && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" &&
        (m.status === "done" || m.status === "error"),
    );
  } catch {
    return [];
  }
}

function saveMessages(messages: Message[]): void {
  try {
    sessionStorage.setItem(ASK_STORAGE_KEY, JSON.stringify(messages.filter((m) => m.status !== "streaming").slice(-MAX_KEPT)));
  } catch {
    // Storage can be full or blocked (private mode). The chat still works for this page.
  }
}

/** The conversation and the streaming request behind it. */
function useAsk() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const restored = useRef(false);
  const abort = useRef<AbortController | null>(null);

  // Restore after mount, so the server render and the first client render match.
  useEffect(() => {
    setMessages(loadMessages());
    restored.current = true;
    return () => abort.current?.abort();
  }, []);

  useEffect(() => {
    if (restored.current) saveMessages(messages);
  }, [messages]);

  const update = (id: string, patch: (m: Message) => Partial<Message>) =>
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch(m) } : m)));

  const send = useCallback(
    async (text: string) => {
      const question = text.trim().slice(0, MAX_QUESTION_CHARS);
      if (!question || busy) return;
      const history: AskTurn[] = messages
        .filter((m) => m.status === "done")
        .slice(-MAX_HISTORY_MESSAGES)
        .map(({ role, content }) => ({ role, content }));
      const answerId = newId();
      setMessages((prev) => [
        ...prev,
        { id: newId(), role: "user" as const, content: question, status: "done" as const },
        { id: answerId, role: "assistant" as const, content: "", status: "streaming" as const },
      ].slice(-MAX_KEPT));
      setBusy(true);
      const controller = new AbortController();
      abort.current = controller;
      try {
        const res = await fetch("/api/ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question, history }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          update(answerId, () => ({ content: data.error ?? FAILED, status: "error" }));
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          if (chunk) update(answerId, (m) => ({ content: m.content + chunk }));
        }
        update(answerId, (m) => (m.content.trim() ? { status: "done" } : { content: FAILED, status: "error" }));
      } catch {
        if (controller.signal.aborted) return;
        update(answerId, (m) => (m.content ? { status: "done" } : { content: OFFLINE, status: "error" }));
      } finally {
        if (abort.current === controller) {
          abort.current = null;
          setBusy(false);
        }
      }
    },
    [busy, messages],
  );

  const reset = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    setBusy(false);
    setMessages([]);
  }, []);

  return { messages, busy, send, reset };
}

function Avatar() {
  return (
    <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-[2px] border-2 border-ink bg-frost text-ink">
      <Mascot className="h-3.5" title="" />
    </span>
  );
}

function Bubble({ m }: { m: Message }) {
  const mine = m.role === "user";
  return (
    <li className={cn("flex items-end gap-2 animate-bubble-in", mine && "justify-end")} aria-busy={m.status === "streaming" || undefined}>
      {!mine && <Avatar />}
      <div
        className={cn(
          "max-w-[85%] rounded-[2px] border-2 border-ink px-3 py-2 text-body [overflow-wrap:anywhere]",
          mine ? "bg-sky/30" : m.status === "error" ? "bg-notebook" : "bg-ice",
        )}
      >
        <span className="sr-only">{mine ? "You" : "Hirakumi"}: </span>
        {m.status === "streaming" && !m.content ? (
          <span className="flex h-6 items-center gap-1">
            <span className="sr-only">Hirakumi is answering</span>
            {[0, 1, 2].map((i) => (
              <span key={i} aria-hidden className="size-1.5 bg-ink animate-typing-dot" style={{ animationDelay: `${i * 140}ms` }} />
            ))}
          </span>
        ) : (
          <p className="whitespace-pre-wrap">{m.content}</p>
        )}
      </div>
    </li>
  );
}

/**
 * "Ask Hirakumi": a floating button (bottom right, on every page) that opens a general help chat. A right-hand
 * drawer from md up, a bottom sheet below. Answers stream from /api/ask. The conversation lives in this tab's
 * sessionStorage, and the component sits in the root layout, so it stays put while the reader navigates.
 */
export function AskHirakumi() {
  const { messages, busy, send, reset } = useAsk();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const inputId = useId();

  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);

  // Open: focus the question box, stop the page behind from scrolling, close on Escape.
  useEffect(() => {
    if (!open) return;
    input.current?.focus({ preventScroll: true });
    const root = document.documentElement;
    const prev = root.style.overflow;
    root.style.overflow = "hidden";
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      root.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  // Keep the newest words in view while an answer streams in.
  const last = messages[messages.length - 1];
  const tail = `${messages.length}:${last?.content.length ?? 0}`;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && open) el.scrollTop = el.scrollHeight;
  }, [tail, open]);

  // Focus trap: Tab and Shift+Tab cycle inside the panel.
  function onPanelKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Tab" || !panel.current) return;
    const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0];
    const lastItem = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !panel.current.contains(active))) {
      e.preventDefault();
      lastItem.focus();
    } else if (!e.shiftKey && (active === lastItem || !panel.current.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  }

  function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!draft.trim() || busy) return;
    void send(draft);
    setDraft("");
  }

  function onInputKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  function startOver() {
    reset();
    input.current?.focus();
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label="Ask Hirakumi"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="fixed right-4 bottom-4 z-30 flex min-h-12 cursor-pointer items-center gap-2 rounded-[2px] border-2 border-ink bg-sky p-1.5 text-body font-semibold text-ink shadow-hard-sm transition-transform duration-100 ease-[var(--ease-press)] active:scale-[0.96] sm:right-6 sm:bottom-6 sm:pr-4"
      >
        <span className="flex size-8 items-center justify-center rounded-[2px] border-2 border-ink bg-frost">
          <Mascot className="h-3.5" title="" />
        </span>
        <span aria-hidden className="hidden sm:inline">Ask Hirakumi</span>
      </button>

      <div
        aria-hidden
        data-ask-scrim
        data-open={open || undefined}
        onClick={close}
        className="ask-scrim fixed inset-0 z-40 bg-ink/40"
      />

      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-hidden={!open || undefined}
        inert={!open}
        data-open={open || undefined}
        onKeyDown={onPanelKeyDown}
        className={cn(
          "ask-panel fixed inset-x-0 bottom-0 z-50 flex h-[85dvh] flex-col border-t-2 border-ink bg-frost shadow-[0_-6px_0_0_var(--color-ink)]",
          "md:inset-y-0 md:right-0 md:left-auto md:h-dvh md:w-[420px] md:border-t-0 md:border-l-2 md:shadow-hard",
        )}
      >
        <header className="flex items-center gap-3 border-b-2 border-ink px-4 py-3">
          <Avatar />
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-body font-semibold">Ask Hirakumi</h2>
            <p className="truncate text-caption text-graphite">Answers about selling your API to agents</p>
          </div>
          {messages.length > 0 && (
            <button
              type="button"
              onClick={startOver}
              aria-label="New chat"
              title="New chat"
              className="flex size-10 cursor-pointer items-center justify-center rounded-[2px] border-2 border-transparent text-ink transition-transform duration-100 hover:border-ink active:scale-[0.96]"
            >
              <RotateCcw aria-hidden className="size-4" />
            </button>
          )}
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="flex size-10 cursor-pointer items-center justify-center rounded-[2px] border-2 border-transparent text-ink transition-transform duration-100 hover:border-ink active:scale-[0.96]"
          >
            <X aria-hidden className="size-5" />
          </button>
        </header>

        <div ref={scroller} data-lenis-prevent className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
          {messages.length === 0 && (
            <div className="space-y-4">
              <div className="flex items-end gap-2">
                <Avatar />
                <p className="max-w-[85%] rounded-[2px] border-2 border-ink bg-ice px-3 py-2 text-body">
                  Hi, I&apos;m Hirakumi. Ask me anything about listing your API, getting paid, or how agents pay.
                </p>
              </div>
              <ul className="flex flex-wrap gap-2 pl-10" aria-label="Suggested questions">
                {SUGGESTED_QUESTIONS.map((q) => (
                  <li key={q}>
                    <button
                      type="button"
                      onClick={() => void send(q)}
                      className="min-h-10 cursor-pointer rounded-[2px] border-2 border-ink bg-frost px-3 py-1.5 text-left text-body font-medium transition-[transform,background-color] duration-100 ease-[var(--ease-press)] hover:bg-chalk active:scale-[0.97]"
                    >
                      {q}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <ol role="log" aria-live="polite" aria-relevant="additions text" aria-label="Conversation" className="space-y-3">
            {messages.map((m) => (
              <Bubble key={m.id} m={m} />
            ))}
          </ol>
        </div>

        <form onSubmit={submit} className="border-t-2 border-ink bg-frost p-3">
          <label htmlFor={inputId} className="sr-only">Your question</label>
          <div className="flex items-end gap-2">
            <textarea
              ref={input}
              id={inputId}
              rows={1}
              value={draft}
              maxLength={MAX_QUESTION_CHARS}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder="Ask a question"
              className="max-h-32 min-h-10 flex-1 resize-none rounded-[2px] border-2 border-ink bg-frost px-3 py-2 text-body outline-none [field-sizing:content] focus-visible:border-sky"
            />
            <button
              type="submit"
              aria-label="Send"
              disabled={!draft.trim() || busy}
              className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-[2px] border-2 border-ink bg-sky text-ink transition-[transform,opacity] duration-100 ease-[var(--ease-press)] active:scale-[0.96] disabled:cursor-default disabled:opacity-50"
            >
              <ArrowUp aria-hidden className="size-4" />
            </button>
          </div>
          {draft.length > MAX_QUESTION_CHARS - 100 && (
            <p className="mt-1 text-right text-caption text-graphite tabular-nums">{`${draft.length} / ${MAX_QUESTION_CHARS}`}</p>
          )}
        </form>
      </div>
    </>
  );
}
