"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { useAuth } from "@/lib/auth-client";

/**
 * Below md the header has no room for its links: a disclosure button opens them in a panel under the bar.
 * Esc closes it and returns focus to the button; following a link closes it.
 */
export function MobileNav({ links }: { links: { href: string; label: string }[] }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const auth = useAuth();
  const pathname = usePathname();

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const all = [...links, ...(auth.status === "in" ? [{ href: "/apis", label: "My APIs" }] : auth.status === "out" ? [{ href: "/login", label: "Log in" }] : [])];
  return (
    <div className="md:hidden">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="flex size-10 cursor-pointer items-center justify-center rounded-[2px] border-[1.5px] border-ink bg-frost text-ink hover:bg-ice"
      >
        {open ? <X aria-hidden className="size-4" /> : <Menu aria-hidden className="size-4" />}
        <span className="sr-only">Menu</span>
      </button>
      <nav
        id={panelId}
        aria-label="Main menu"
        hidden={!open}
        className="absolute inset-x-0 top-16 z-40 border-b border-ink bg-frost px-4 py-2 shadow-hard-sm"
      >
        <ul className="flex flex-col">
          {all.map((l) => (
            <li key={l.label}>
              <Link
                href={l.href}
                onClick={() => setOpen(false)}
                className="block py-3 text-caption font-medium uppercase tracking-[0.06em] underline-offset-4 hover:underline"
              >
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
