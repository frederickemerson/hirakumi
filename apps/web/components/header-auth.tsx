"use client";

import { ChevronDown, Wallet } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { buttonVariants } from "@/components/ui/button";
import { logOut, useAuth } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

// Same length as a real short address, so the hidden signed-in layer reserves its true width.
const PLACEHOLDER_ADDRESS = "addr_test1qz…000000";

const navLink = "py-2 text-caption font-medium uppercase tracking-[0.06em] underline-offset-4 hover:underline";
const layer = "col-start-1 row-start-1 flex items-center justify-end gap-4 transition-opacity duration-150 ease-out motion-reduce:transition-none";

/**
 * The right side of the header. Both states sit in the same grid cell, so the cell is always as wide
 * as the wider one and the swap is a crossfade, never a layout shift. The page around it stays static.
 */
export function HeaderAuth() {
  const auth = useAuth();
  const pathname = usePathname() ?? "";
  // Seller pages only render for a signed-in seller and seed the session at hydration:
  // show nothing there until then rather than flash "Log in".
  const view = auth.status === "in" ? "in" : auth.status === "unknown" && /^\/apis(\/|$)/.test(pathname) ? "pending" : "out";
  return (
    <div className="grid items-center justify-items-end">
      <div data-auth-layer="out" aria-hidden={view !== "out" || undefined} inert={view !== "out"} className={cn(layer, view !== "out" && "pointer-events-none opacity-0")}>
        <Link href="/login" className={cn(navLink, "hidden sm:inline")}>
          Log in
        </Link>
        <Link href="/login" className={cn(buttonVariants({ variant: "nav", size: "sm" }), "min-h-9")}>
          List your API
        </Link>
      </div>
      <div data-auth-layer="in" aria-hidden={view !== "in" || undefined} inert={view !== "in"} className={cn(layer, view !== "in" && "pointer-events-none opacity-0")}>
        <Link href="/apis" className={cn(buttonVariants({ variant: "nav", size: "sm" }), "hidden min-h-9 sm:inline-flex")}>
          My APIs
        </Link>
        <AccountMenu address={auth.status === "in" ? auth.address : PLACEHOLDER_ADDRESS} />
      </div>
    </div>
  );
}

/** Menu button pattern: Enter, Space or the arrow keys open it, arrows move, Esc closes and returns focus. */
function AccountMenu({ address }: { address: string }) {
  const router = useRouter();
  const menuId = useId();
  const wrapper = useRef<HTMLDivElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [focusOnOpen, setFocusOnOpen] = useState<"first" | "last">("first");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items = () => Array.from(wrapper.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  function close(returnFocus: boolean) {
    setOpen(false);
    setError(null);
    if (returnFocus) chip.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    const list = items();
    (focusOnOpen === "last" ? list[list.length - 1] : list[0])?.focus();
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapper.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the menu opens, not on every render
  }, [open]);

  function onChipKeyDown(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setFocusOnOpen(e.key === "ArrowUp" ? "last" : "first");
      setOpen(true);
    }
  }

  function onMenuKeyDown(e: KeyboardEvent) {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const move = (i: number) => {
      e.preventDefault();
      list[(i + list.length) % list.length]?.focus();
    };
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else if (e.key === "ArrowDown") move(at + 1);
    else if (e.key === "ArrowUp") move(at - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(list.length - 1);
    else if (e.key === "Tab") close(false);
  }

  async function onLogOut() {
    setPending(true);
    setError(null);
    const ok = await logOut();
    setPending(false);
    if (!ok) {
      setError("Couldn't log out. Try again.");
      return;
    }
    setOpen(false);
    router.push("/");
    router.refresh();
  }

  const item = "block w-full px-4 py-2.5 text-left text-body hover:bg-ice focus-visible:bg-ice";
  return (
    <div ref={wrapper} className="relative">
      <button
        ref={chip}
        type="button"
        aria-label={`Account ${address}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          setFocusOnOpen("first");
          if (open) close(false);
          else setOpen(true);
        }}
        onKeyDown={onChipKeyDown}
        className="inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-[2px] border-[1.5px] border-ink bg-frost px-3 text-caption font-medium transition-colors duration-150 hover:bg-ice"
      >
        <Wallet aria-hidden className="size-3.5 shrink-0" />
        <span className="whitespace-nowrap">{address}</span>
        <ChevronDown aria-hidden className={cn("size-3.5 shrink-0 transition-transform duration-150", open && "rotate-180")} />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 min-w-52 rounded-[2px] border-2 border-ink bg-frost shadow-hard-sm animate-in fade-in-0 duration-150 motion-reduce:animate-none">
          <div id={menuId} role="menu" aria-label="Account" onKeyDown={onMenuKeyDown} className="py-1">
            <Link role="menuitem" tabIndex={-1} href="/apis" onClick={() => close(false)} className={item}>
              My APIs
            </Link>
            <Link role="menuitem" tabIndex={-1} href="/apis/new" onClick={() => close(false)} className={item}>
              List a new API
            </Link>
            <button role="menuitem" tabIndex={-1} type="button" onClick={() => void onLogOut()} aria-busy={pending || undefined} disabled={pending} className={cn(item, "cursor-pointer border-t border-silver disabled:cursor-progress")}>
              {pending ? "Logging out…" : "Log out"}
            </button>
          </div>
          {error && (
            <p role="alert" className="border-t border-silver px-4 py-2.5 text-caption text-graphite">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
