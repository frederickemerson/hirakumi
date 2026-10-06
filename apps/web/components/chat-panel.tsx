"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { InlineError } from "@/components/states";
import { Button } from "@/components/ui/button";
import { getJson, postJson, RequestError } from "@/lib/client-fetch";
import { cn } from "@/lib/utils";

type Msg = { id: string; author: "seller" | "coworker"; body: string; createdAt: string };

function merge(prev: Msg[], incoming: Msg[]): Msg[] {
  const seen = new Set(prev.map((m) => m.id));
  return [...prev, ...incoming.filter((m) => !seen.has(m.id))];
}

export function ChatPanel({ apiId }: { apiId: string | null }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [loadError, setLoadError] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const lastId = useRef("0");
  const query = apiId ? `&apiId=${encodeURIComponent(apiId)}` : "";

  const load = useCallback(async () => {
    try {
      const data = await getJson<{ messages: Msg[] }>(`/api/chat?after=${lastId.current}${query}`);
      if (data.messages.length > 0) {
        lastId.current = data.messages[data.messages.length - 1].id;
        setMessages((prev) => merge(prev, data.messages));
      }
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [query]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [load]);

  async function send(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setSendError(null);
    setSending(true);
    try {
      const data = await postJson<{ message: Msg }>("/api/chat", { apiId, body: text });
      setDraft("");
      setMessages((prev) => merge(prev, [data.message]));
    } catch (err) {
      setSendError(err instanceof RequestError ? err.message : "Your message wasn't sent. Try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <section aria-label="Chat with the Hirakumi coworker" className="space-y-4 rounded-[2px] border-2 border-ink bg-frost p-5">
      <h2 className="text-body font-semibold uppercase tracking-[0.04em]">Chat with Hirakumi</h2>
      {loadError && <InlineError>We couldn&apos;t load messages. Retrying…</InlineError>}
      {messages.length === 0 ? (
        <p className="text-body text-graphite">Ask the Hirakumi coworker anything about listing your API. Replies appear here.</p>
      ) : (
        <ul className="max-h-96 space-y-3 overflow-y-auto text-body">
          {messages.map((m) => (
            <li key={m.id} className={cn("rounded-[2px] border border-ink p-3", m.author === "seller" ? "bg-notebook" : "bg-ice")}>
              <span className="block text-caption font-semibold uppercase tracking-[0.04em] text-graphite">{m.author === "seller" ? "You" : "Hirakumi coworker"}</span>
              <p className="whitespace-pre-wrap">{m.body}</p>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={send} className="space-y-3">
        <label htmlFor="chat-draft" className="sr-only">Message</label>
        <textarea id="chat-draft" rows={3} disabled={sending}
          className="w-full rounded-[2px] border-2 border-ink bg-frost p-3 text-body outline-none placeholder:text-pencil focus-visible:border-sky disabled:bg-chalk"
          placeholder="Ask about your listing…" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <Button type="submit" size="sm" disabled={!draft.trim()} pending={sending} pendingLabel="Sending…">Send</Button>
        {sendError && <InlineError>{sendError}</InlineError>}
      </form>
    </section>
  );
}
