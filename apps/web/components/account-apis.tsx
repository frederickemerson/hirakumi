"use client";

import Link from "next/link";
import { useRef, useState, type ReactNode } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DeleteApiButton } from "@/components/delete-api-button";
import { EmptyState } from "@/components/states";
import { StatusLight } from "@/components/status-light";
import { toast } from "@/components/toast";
import { buttonVariants } from "@/components/ui/button";
import { accountTotals, passRatePct, type AccountApi } from "@/lib/account";
import { postJson } from "@/lib/client-fetch";
import { formatTime, RETIRE_COPY } from "@/lib/copy";
import { formatTusdm } from "@/lib/money";
import { cn } from "@/lib/utils";

const COLLAPSE_MS = 220;

/** Reduced motion (or no matchMedia, as in tests) removes a deleted row at once instead of collapsing it. */
function motionAllowed(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Totals and the seller's APIs, with Retire and Delete (any stage). The list is local state seeded by the server, so a
 * confirmed change shows at once (status light, actions and totals) without waiting on a page reload.
 * `children` renders between the totals and the list (the account details).
 */
export function AccountApis({ initial, children }: { initial: AccountApi[]; children?: ReactNode }) {
  const [apis, setApis] = useState(initial);
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const heading = useRef<HTMLHeadingElement>(null);
  const totals = accountTotals(apis.filter((a) => !leaving.has(a.id)));

  function remove(id: string) {
    setApis((list) => list.filter((a) => a.id !== id));
    setLeaving((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
    heading.current?.focus(); // the row that held focus is gone: land on the list, not on <body>
  }

  /** After the server confirmed the delete: collapse the row, then drop it. */
  function deleted(a: AccountApi) {
    if (!motionAllowed()) return remove(a.id);
    setLeaving((s) => new Set(s).add(a.id));
    setTimeout(() => remove(a.id), COLLAPSE_MS);
  }

  async function retire(a: AccountApi) {
    await postJson(`/api/apis/${a.id}/retire`, {});
    setApis((list) => list.map((x) => (x.id === a.id
      ? { ...x, state: "retired", badge: { tone: "retired", label: "Retired", detail: null },
          recordsKept: "It reached the Masumi registry, so we keep its records." }
      : x)));
    toast(`Retired ${a.name}`);
  }

  return (
    <>
      <ul aria-label="Totals" className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-3">
        <Total label="Live APIs" value={String(totals.live)} />
        <Total label="Paid calls, 24 h" value={String(totals.paidCallsDay)} />
        <Total label="Total received" value={`${formatTusdm(totals.receivedMicros)} tUSDM`} />
      </ul>

      {children}

      <section aria-labelledby="your-apis" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="your-apis" ref={heading} tabIndex={-1} className="text-sub font-medium uppercase outline-none">
            Your APIs
          </h2>
          <Link href="/apis/new" className={buttonVariants({ size: "sm" })}>Add an API</Link>
        </div>
        {apis.length === 0 ? (
          <EmptyState title="You haven't listed an API yet." detail="Add your first API with a link to its OpenAPI description." />
        ) : (
          <ul className="overflow-hidden rounded-[2px] border-2 border-ink bg-frost">
            {apis.map((a, i) => (
              <ApiRow key={a.id} api={a} first={i === 0} leaving={leaving.has(a.id)} onDeleted={() => deleted(a)} onRetire={() => retire(a)} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function Total({ label, value }: { label: string; value: string }) {
  return (
    <li className="rounded-[2px] border-2 border-ink bg-frost p-4">
      <p className="text-caption uppercase tracking-[0.04em] text-graphite">{label}</p>
      <p className="mt-1 text-h-sm font-medium tabular-nums">{value}</p>
    </li>
  );
}

function ApiRow({ api: a, first, leaving, onDeleted, onRetire }: {
  api: AccountApi;
  first: boolean;
  leaving: boolean;
  onDeleted: () => void;
  onRetire: () => Promise<void>;
}) {
  const nameId = `api-${a.id}-name`;
  const rate = passRatePct(a);
  const live = a.state === "live";
  return (
    <li
      aria-labelledby={nameId}
      aria-hidden={leaving || undefined}
      className={cn(
        "grid transition-[grid-template-rows,opacity] ease-out motion-reduce:transition-none",
        leaving ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100",
      )}
      style={{ transitionDuration: `${COLLAPSE_MS}ms` }}
    >
      <div className="min-h-0 overflow-hidden">
        <div className={cn("space-y-4 p-4", !first && "border-t-2 border-ink")}>
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2.5">
              <StatusLight tone={a.badge.tone} state={a.state} />
              <h3 id={nameId} className="min-w-0 text-body-lg font-medium break-words">{a.name}</h3>
            </div>
            {a.badge.detail && <p className="text-caption text-graphite">{a.badge.detail}</p>}
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-body sm:grid-cols-4">
            <Fact label="Paid calls, 24 h" value={String(a.paidCallsDay)} />
            <Fact label="Kept the promise" value={rate === null ? "No paid calls" : `${rate}%`} />
            <Fact label="Received" value={`${formatTusdm(a.receivedMicros)} tUSDM`} />
            <Fact label="Last health check" value={a.healthCheckedAt ? formatTime(a.healthCheckedAt) : live ? "Not yet" : "Not monitored"} />
          </dl>

          <div className="flex flex-wrap gap-2">
            <Link href={`/apis/${a.id}`} className={buttonVariants({ variant: "outline", size: "xs" })}>Open</Link>
            {live && (
              <Link href={`/p/${a.id}/try`} className={buttonVariants({ variant: "outline", size: "xs" })}>Try it live</Link>
            )}
            {live && (
              <ConfirmDialog
                triggerLabel={RETIRE_COPY.trigger}
                title={RETIRE_COPY.title(a.name)}
                description={RETIRE_COPY.description}
                confirmLabel={RETIRE_COPY.confirm}
                pendingLabel={RETIRE_COPY.pending}
                onConfirm={onRetire}
              />
            )}
            <DeleteApiButton api={a} onDeleted={onDeleted} />
          </div>
        </div>
      </div>
    </li>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-caption uppercase tracking-[0.04em] text-graphite">{label}</dt>
      <dd className="mt-0.5 font-medium tabular-nums break-words">{value}</dd>
    </div>
  );
}
