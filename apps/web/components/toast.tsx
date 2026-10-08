"use client";

import { useEffect, useState } from "react";

/**
 * A tiny local toast: `toast("Price saved")` from anywhere on the client, one <Toaster /> in the root
 * layout. Short confirmations only; errors stay inline next to what failed.
 */
type Toast = { id: number; text: string; leaving: boolean };
type Listener = (text: string) => void;

const listeners = new Set<Listener>();
const TOAST_MS = 2_400;
const EXIT_MS = 160;

export function toast(text: string): void {
  for (const l of listeners) l(text);
}

export function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => {
    let next = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (fn: () => void, ms: number) => {
      const t = setTimeout(() => {
        timers.delete(t);
        fn();
      }, ms);
      timers.add(t);
    };
    const add: Listener = (text) => {
      const id = ++next;
      setToasts((list) => [...list.slice(-2), { id, text, leaving: false }]);
      later(() => setToasts((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t))), TOAST_MS);
      later(() => setToasts((list) => list.filter((t) => t.id !== id)), TOAST_MS + EXIT_MS);
    };
    listeners.add(add);
    return () => {
      listeners.delete(add);
      for (const t of timers) clearTimeout(t);
    };
  }, []);

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-4 bottom-4 z-40 flex flex-col items-end gap-2 sm:inset-x-auto sm:right-6 sm:bottom-6"
    >
      {toasts.map((t) => (
        <p
          key={t.id}
          className={`pointer-events-auto flex items-center gap-2 rounded-[2px] border-2 border-ink bg-frost px-4 py-3 text-body font-medium shadow-hard-sm transition-[opacity,transform] duration-150 ease-in motion-reduce:transition-none ${
            t.leaving ? "translate-y-1 opacity-0" : "animate-toast-in"
          }`}
        >
          <span aria-hidden className="flex size-5 items-center justify-center rounded-[2px] border border-ink bg-mint/40 text-caption">✓</span>
          {t.text}
        </p>
      ))}
    </div>
  );
}
