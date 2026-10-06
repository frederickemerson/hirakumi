"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getJson, postJson, RequestError } from "@/lib/client-fetch";

/*
 * The seller <-> Hirakumi coworker conversation (/api/chat). The guide panel renders it
^ * (components/seller-guide.tsx); this file owns the data: polling, merging and sending.
 */

export type ChatMessage = { id: string; author: "seller" | "coworker"; body: string; createdAt: string; pending?: boolean };

function merge(prev: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const seen = new Set(prev.map((m) => m.id));
  return [...prev, ...incoming.filter((m) => !seen.has(m.id))];
}

export type Chat = {
  messages: ChatMessage[];
  loadError: boolean;
  /** True once the first load has answered (with or without messages). */
  loaded: boolean;
  sendError: string | null;
  /** Shows the message at once, then confirms it with the server. Resolves true when it was saved. */
  send: (text: string) => Promise<boolean>;
};

/** Polls the chat every 3 s while `enabled`. Sending is optimistic: the bubble appears before the server answers. */
export function useChat(apiId: string | null, enabled = true): Chat {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const lastId = useRef("0");
  const query = apiId ? `&apiId=${encodeURIComponent(apiId)}` : "";

  const load = useCallback(async () => {
    try {
      const data = await getJson<{ messages: ChatMessage[] }>(`/api/chat?after=${lastId.current}${query}`);
      if (data.messages.length > 0) {
        lastId.current = data.messages[data.messages.length - 1].id;
        setMessages((prev) => merge(prev, data.messages));
      }
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoaded(true);
    }
  }, [query]);

  useEffect(() => {
    if (!enabled) return;
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [load, enabled]);

  const send = useCallback(
    async (text: string) => {
      const body = text.trim();
      if (!body) return false;
      setSendError(null);
      const tempId = `pending-${Date.now()}`;
      setMessages((prev) => [...prev, { id: tempId, author: "seller", body, createdAt: new Date().toISOString(), pending: true }]);
      try {
        const data = await postJson<{ message: ChatMessage }>("/api/chat", { apiId, body });
        // Swap the optimistic bubble for the saved one (unless a poll already brought it in).
        setMessages((prev) => {
          const without = prev.filter((m) => m.id !== tempId);
          return merge(without, [data.message]);
        });
        return true;
      } catch (err) {
        setMessages((prev) => prev.filter((m) => m.id !== tempId));
        setSendError(err instanceof RequestError ? err.message : "Your message wasn't sent. Try again.");
        return false;
      }
    },
    [apiId],
  );

  return { messages, loadError, loaded, sendError, send };
}
