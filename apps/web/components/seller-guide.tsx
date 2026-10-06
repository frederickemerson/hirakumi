"use client";

import { ArrowUp, ChevronDown, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Mascot } from "@/components/brand/mascot";
import { InlineError } from "@/components/states";
import { GUIDE, guideMessages, guideStepFor, type GuideStepKey } from "@/lib/guide";
import { motionAllowed } from "@/lib/motion";
import { PROGRESS_EVENT, type ApiProgress } from "@/lib/progress";
import { useChat, type ChatMessage } from "@/lib/use-chat";
import { cn } from "@/lib/utils";

/** How long Hirakumi "types" before a new step's messages land. Skipped with reduced motion. */
export const TYPING_MS = 650;
/** Older steps kept in the thread, so the seller can scroll back a little without it growing forever. */
const MAX_TURNS = 3;

type Turn = { id: number; step: GuideStepKey; animate: boolean };

/**
 * Keeps the API's progress current for the guide without a second poller: it starts from the server
 * snapshot, follows the waiting screens' poller (PROGRESS_EVENT), and re-reads the small progress
 * endpoint after a client-side navigation (the layout that renders the guide does not re-render then).
 */
function useGuideProgress(apiId: string | null, initial: ApiProgress | null): ApiProgress | null {
  const [progress, setProgress] = useState(initial);
  const pathname = usePathname();
  const lastPath = useRef(pathname);

  useEffect(() => setProgress(initial), [initial]);

  useEffect(() => {
    if (!apiId) return;
    const prefix = `/apis/${apiId}/`;
    const onProgress = (e: Event) => {
      const next = (e as CustomEvent<ApiProgress>).detail;
      if (next?.href?.startsWith(prefix)) setProgress(next);
    };
    window.addEventListener(PROGRESS_EVENT, onProgress);
    return () => window.removeEventListener(PROGRESS_EVENT, onProgress);
  }, [apiId]);

  useEffect(() => {
    if (!apiId || pathname === lastPath.current) return;
    lastPath.current = pathname;
    let cancelled = false;
    fetch(`/api/apis/${encodeURIComponent(apiId)}/progress`, { cache: "no-store", headers: { accept: "application/json" } })
      .then((res) => (res.ok ? (res.json() as Promise<ApiProgress>) : null))
      .then((next) => {
        if (!cancelled && next) setProgress(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [apiId, pathname]);

  return progress;
}

/** The thread of guide turns. A new step adds a turn after a short typing pause. */
function useTurns(step: GuideStepKey): { turns: Turn[]; typing: boolean } {
  const [turns, setTurns] = useState<Turn[]>(() => [{ id: 0, step, animate: false }]);
  const [typing, setTyping] = useState(false);

  useEffect(() => {
    if (turns[turns.length - 1].step === step) return;
    const add = () => {
      setTyping(false);
      setTurns((prev) => [...prev, { id: prev[prev.length - 1].id + 1, step, animate: motionAllowed() }].slice(-MAX_TURNS));
    };
    if (!motionAllowed()) {
      add();
      return;
    }
    setTyping(true);
    const t = setTimeout(add, TYPING_MS);
    return () => clearTimeout(t);
  }, [step, turns]);

  return { turns, typing };
}

function Avatar({ hidden = false }: { hidden?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-[2px] border-2 border-ink bg-frost text-ink",
        hidden && "invisible",
      )}
    >
      <Mascot className="h-4" title="" />
    </span>
  );
}

function Bubble({ children, index, animate, first, tone = "guide" }: {
  children: React.ReactNode;
  index: number;
  animate: boolean;
  first: boolean;
  tone?: "guide" | "todo";
}) {
  return (
    <li
      className={cn("flex items-end gap-2", animate && "animate-bubble-in")}
      style={animate ? { animationDelay: `${index * 90}ms` } : undefined}
    >
      <Avatar hidden={!first} />
      <p
        className={cn(
          "max-w-[85%] rounded-[2px] border-2 border-ink px-3 py-2 text-body [overflow-wrap:anywhere]",
          tone === "todo" ? "bg-notebook" : "bg-ice",
        )}
      >
        {children}
      </p>
    </li>
  );
}

function TurnView({ turn, latest }: { turn: Turn; latest: boolean }) {
  const step = GUIDE[turn.step];
  const lines = guideMessages(step);
  return (
    <li className={cn("space-y-2", !latest && "opacity-60")}>
      <p className="flex items-center gap-2 text-caption font-semibold uppercase tracking-[0.06em] text-graphite">
        <span aria-hidden className="h-px flex-1 bg-silver" />
        {step.title}
        <span aria-hidden className="h-px flex-1 bg-silver" />
      </p>
      <ul className="space-y-2">
        {lines.map((line, i) => (
          <Bubble key={line} index={i} animate={turn.animate} first={i === 0} tone={line === step.todo ? "todo" : "guide"}>
            {line === step.todo && <span className="font-semibold">Your turn. </span>}
            {line}
          </Bubble>
        ))}
      </ul>
      {latest && step.faqs.length > 0 && (
        <div
          className={cn("space-y-1 pl-10", turn.animate && "animate-bubble-in")}
          style={turn.animate ? { animationDelay: `${lines.length * 90}ms` } : undefined}
        >
          {step.faqs.map((f) => (
            <details key={f.q} className="group rounded-[2px] border border-silver bg-frost open:border-ink">
              <summary className="flex min-h-10 cursor-pointer items-center justify-between gap-2 px-3 py-2 text-body font-medium select-none hover:bg-chalk">
                {f.q}
                <ChevronDown aria-hidden className="size-4 shrink-0 transition-transform duration-200 ease-[var(--ease-snap)] group-open:rotate-180" />
              </summary>
              <p className="px-3 pb-3 text-body text-graphite">{f.a}</p>
            </details>
          ))}
        </div>
      )}
    </li>
  );
}

function ChatBubble({ m }: { m: ChatMessage }) {
  const mine = m.author === "seller";
  return (
    <li className={cn("flex items-end gap-2 animate-bubble-in", mine && "justify-end")}>
      {!mine && <Avatar />}
      <div
        className={cn(
          "max-w-[85%] rounded-[2px] border-2 border-ink px-3 py-2 text-body [overflow-wrap:anywhere] transition-opacity duration-150",
          mine ? "bg-sky/30" : "bg-ice",
          m.pending && "opacity-70",
        )}
      >
        <span className="sr-only">{mine ? "You" : "Hirakumi coworker"}: </span>
        <p className="whitespace-pre-wrap">{m.body}</p>
      </div>
    </li>
  );
}

function TypingDots() {
  return (
    <li className="flex items-end gap-2">
      <Avatar />
      <span className="flex h-9 items-center gap-1 rounded-[2px] border-2 border-ink bg-ice px-3">
        <span className="sr-only">Hirakumi is typing</span>
        {[0, 1, 2].map((i) => (
          <span key={i} aria-hidden className="size-1.5 bg-ink animate-typing-dot" style={{ animationDelay: `${i * 140}ms` }} />
        ))}
      </span>
    </li>
  );
}

function Composer({ onSend, error }: { onSend: (text: string) => Promise<boolean>; error: string | null }) {
  const [draft, setDraft] = useState("");
  const id = useId();

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft(""); // Optimistic: the bubble is already in the thread.
    const ok = await onSend(text);
    if (!ok) setDraft(text);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2 border-t-2 border-ink bg-frost p-3">
      <label htmlFor={id} className="sr-only">Ask Hirakumi a question</label>
      <div className="flex items-end gap-2">
        <textarea
          id={id}
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask a question…"
          className="max-h-32 min-h-10 flex-1 resize-none rounded-[2px] border-2 border-ink bg-frost px-3 py-2 text-body outline-none [field-sizing:content] focus-visible:border-sky"
        />
        <button
          type="submit"
          aria-label="Send"
          disabled={!draft.trim()}
          className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-[2px] border-2 border-ink bg-sky text-ink transition-[transform,opacity] duration-100 ease-[var(--ease-press)] active:scale-[0.96] disabled:cursor-default disabled:opacity-50"
        >
          <ArrowUp aria-hidden className="size-4" />
        </button>
      </div>
      {error && <InlineError>{error}</InlineError>}
    </form>
  );
}

/**
 * The seller's step-by-step guide: Hirakumi explains the current onboarding step (what is happening,
 * what to do, why it is safe, what comes next, how long it takes), with short FAQs, and the chat with
 * the Hirakumi coworker underneath.
 *
 * One element, two shapes: a sticky right-hand column from lg up, and a bottom sheet below lg, opened
 * by a floating "Need help?" button. The column is reserved by the parent grid, so nothing shifts when
 * it mounts. The step follows the API live (see useGuideProgress).
 */
export function SellerGuide({ apiId, initial, chatEnabled }: { apiId: string | null; initial: ApiProgress | null; chatEnabled: boolean }) {
  const progress = useGuideProgress(apiId, initial);
  const step = guideStepFor(progress);
  const { turns, typing } = useTurns(step);
  const chat = useChat(apiId, chatEnabled);
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const thread = useRef<HTMLOListElement>(null);
  const panelId = useId();

  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);

  // A new step while the sheet is closed: mark the button.
  const lastTurnId = turns[turns.length - 1].id;
  const seenTurn = useRef(lastTurnId);
  useEffect(() => {
    if (lastTurnId === seenTurn.current) return;
    seenTurn.current = lastTurnId;
    if (!open) setUnread(true);
  }, [lastTurnId, open]);

  // Opening: focus moves into the sheet, the page behind stops scrolling, Escape closes.
  useEffect(() => {
    if (!open) return;
    setUnread(false);
    closeButton.current?.focus({ preventScroll: true });
    const root = document.documentElement;
    const prev = root.style.overflow;
    root.style.overflow = "hidden";
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      root.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  // Keep the newest message in view, but open on the guide: the chat history that loads with the
  // page does not scroll it away, only messages and steps that arrive after that do.
  const signature = `${lastTurnId}:${chat.messages.length}:${typing}`;
  const settled = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (settled.current === null) {
      if (!chatEnabled || chat.loaded) settled.current = signature;
      return;
    }
    if (!el || signature === settled.current) return;
    const chatMoved = settled.current.split(":")[1] !== String(chat.messages.length);
    settled.current = signature;
    // A chat message: go to the bottom. A guide step (or the typing dots): bring the newest turn up.
    const last = thread.current?.lastElementChild as HTMLElement | null;
    const top = chatMoved || !last ? el.scrollHeight : Math.max(0, last.offsetTop - 16);
    if (motionAllowed()) el.scrollTo({ top, behavior: "smooth" });
    else el.scrollTop = top;
  }, [signature, chat.loaded, chat.messages.length, chatEnabled]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(true)}
        className="fixed right-4 bottom-4 z-30 flex min-h-12 cursor-pointer items-center gap-2 rounded-[2px] border-2 border-ink bg-sky py-2 pr-4 pl-2 text-body font-semibold text-ink shadow-hard-sm transition-transform duration-100 ease-[var(--ease-press)] active:scale-[0.96] lg:hidden"
      >
        <span className="flex size-8 items-center justify-center rounded-[2px] border-2 border-ink bg-frost">
          <Mascot className="h-3.5" title="" />
        </span>
        Need help?
        {unread && (
          <span className="absolute -top-1.5 -right-1.5 size-3 border-2 border-ink bg-bill">
            <span className="sr-only">New message</span>
          </span>
        )}
      </button>

      <div
        aria-hidden
        onClick={close}
        data-open={open || undefined}
        className="guide-scrim fixed inset-0 z-40 bg-ink/40 lg:hidden"
      />

      <aside
        id={panelId}
        role={open ? "dialog" : "complementary"}
        aria-modal={open || undefined}
        aria-label="Hirakumi guide"
        data-open={open || undefined}
        className={cn(
          "guide-sheet fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col border-t-2 border-ink bg-frost shadow-[0_-6px_0_0_var(--color-ink)]",
          "lg:sticky lg:top-6 lg:z-auto lg:self-start lg:max-h-[calc(100dvh-3rem)] lg:border-2 lg:shadow-hard",
        )}
      >
        <header className="flex items-center gap-3 border-b-2 border-ink px-4 py-3">
          <Avatar />
          <div className="min-w-0 flex-1">
            <p className="text-body font-semibold">Hirakumi</p>
            <p className="truncate text-caption text-graphite">{`Guide · ${GUIDE[step].title}`}</p>
          </div>
          <button
            ref={closeButton}
            type="button"
            onClick={close}
            aria-label="Close guide"
            className="flex size-10 cursor-pointer items-center justify-center rounded-[2px] border-2 border-transparent text-ink transition-transform duration-100 hover:border-ink active:scale-[0.96] lg:hidden"
          >
            <X aria-hidden className="size-5" />
          </button>
        </header>

        <div ref={scroller} data-lenis-prevent className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
          <ol ref={thread} aria-live="polite" aria-relevant="additions" className="space-y-5">
            {turns.map((t, i) => (
              <TurnView key={t.id} turn={t} latest={i === turns.length - 1} />
            ))}
            {typing && <TypingDots />}
          </ol>
          {chat.messages.length > 0 && (
            <ul aria-live="polite" aria-relevant="additions" className="mt-5 space-y-2">
              {chat.messages.map((m) => (
                <ChatBubble key={m.id} m={m} />
              ))}
            </ul>
          )}
          {chatEnabled && chat.loadError && <InlineError className="mt-3">We couldn&apos;t load messages. Retrying…</InlineError>}
        </div>

        {chatEnabled && <Composer onSend={chat.send} error={chat.sendError} />}
      </aside>
    </>
  );
}
