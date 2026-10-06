import type { ReactNode } from "react";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { Elapsed } from "./elapsed";

/**
 * Something is happening on the server: a spinner, what it is and how long it has been going.
 * Pair it with <LiveProgress>, which polls and moves the seller on when it is done.
 */
export function WaitingState({ title, detail, since, children }: { title: string; detail?: string; since?: Date | string | null; children?: ReactNode }) {
  return (
    <div role="status" aria-live="polite" className="space-y-3 rounded-[2px] border-2 border-ink bg-frost p-6">
      <p className="flex items-center gap-3 font-medium">
        <Spinner className="size-3.5" />
        <span>{title}</span>
        <Elapsed since={since} prefix="" className="ml-auto text-caption text-graphite" />
      </p>
      {detail && <p className="text-body text-graphite">{detail}</p>}
      {children}
    </div>
  );
}

/** Something went wrong: what, and what to do about it. Ink text with a coral rule, never red-on-cream. */
export function ErrorState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return (
    <div role="alert" className="space-y-2 rounded-[2px] border-2 border-ink border-l-8 border-l-coral bg-frost p-6">
      <p className="font-medium">{title}</p>
      <p className="text-body">{detail}</p>
      {action}
    </div>
  );
}

export function EmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return (
    <div className="space-y-2 rounded-[2px] border-2 border-dashed border-graphite p-6 text-center">
      <p className="font-medium">{title}</p>
      <p className="text-body text-graphite">{detail}</p>
      {action}
    </div>
  );
}

/** Inline error under a form control. */
export function InlineError({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p role="alert" className={cn("border-l-4 border-coral pl-3 text-body", className)}>
      {children}
    </p>
  );
}

/** Something the seller should know that doesn't stop them, such as an overlap with their own listing. */
export function NoticeList({ items, className }: { items: string[]; className?: string }) {
  if (items.length === 0) return null;
  return (
    <ul role="note" className={cn("space-y-1 border-l-4 border-sky pl-3 text-body", className)}>
      {items.map((t) => <li key={t}>{t}</li>)}
    </ul>
  );
}

/** Inline "it worked" or "working on it" line under a form control. */
export function InlineStatus({ children, className, busy = false }: { children: ReactNode; className?: string; busy?: boolean }) {
  return (
    <p role="status" aria-live="polite" className={cn("flex items-center gap-2 border-l-4 pl-3 text-body", busy ? "border-sky" : "border-mint", className)}>
      {busy && <Spinner className="size-3" />}
      <span>{children}</span>
    </p>
  );
}
