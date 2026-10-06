"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { InlineError } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { postJson, RequestError } from "@/lib/client-fetch";
import { needsNoSideEffectConfirmation, validateEndpointSelection, type EndpointSelection } from "@/lib/endpoints";
import { startRouteProgress } from "@/lib/route-progress";
import type { Operation } from "@/lib/types";
import { cn } from "@/lib/utils";

function withItem(set: Set<string>, id: string, on: boolean): Set<string> {
  const next = new Set(set);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

export function EndpointsForm({ apiId, operations, initialEscrowOpId }: {
  apiId: string;
  operations: Operation[];
  initialEscrowOpId: string | null;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(() => new Set(operations.filter((o) => o.enabled).map((o) => o.id)));
  const [confirmed, setConfirmed] = useState(() => new Set(operations.filter((o) => o.sideEffectsConfirmedNone).map((o) => o.id)));
  const [escrow, setEscrow] = useState<string | null>(() => operations.find((o) => o.opId === initialEscrowOpId)?.id ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selection: EndpointSelection = {
    enabledIds: operations.filter((o) => enabled.has(o.id)).map((o) => o.id),
    confirmedNoSideEffectIds: operations.filter((o) => enabled.has(o.id) && confirmed.has(o.id)).map((o) => o.id),
    escrowOperationId: escrow,
  };
  const problem = validateEndpointSelection(operations, selection);

  function toggleEnabled(id: string, on: boolean) {
    setEnabled((prev) => withItem(prev, id, on));
    if (!on) {
      setConfirmed((prev) => withItem(prev, id, false));
      if (escrow === id) setEscrow(null);
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await postJson(`/api/apis/${apiId}/endpoints`, selection);
      startRouteProgress();
      router.push(`/apis/${apiId}/ownership`);
    } catch (e) {
      setError(e instanceof RequestError ? e.message : "Something went wrong. Try again.");
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6" aria-busy={busy || undefined}>
      <p className="text-body-lg">
        Every endpoint starts blocked. Tick the ones agents may buy. Only sell endpoints that read data and change nothing.
      </p>
      <ul className="divide-y-2 divide-ink rounded-[2px] border-2 border-ink bg-frost">
        {operations.map((op) => {
          const label = `${op.method.toUpperCase()} ${op.path}`;
          const isOn = enabled.has(op.id);
          return (
            <li key={op.id} className={cn("space-y-3 p-4 transition-colors sm:p-5", isOn && "bg-notebook")}>
              <label className="flex cursor-pointer items-center gap-3">
                <input type="checkbox" aria-label={`Sell ${label}`} checked={isOn} disabled={busy}
                  onChange={(e) => toggleEnabled(op.id, e.target.checked)} />
                <Badge variant={op.method.toUpperCase() === "GET" ? "sky" : "secondary"}>{op.method.toUpperCase()}</Badge>
                <code className="text-body-lg">{op.path}</code>
              </label>
              <p className="text-body text-graphite">{op.description ?? "No description yet."}</p>
              {op.sideEffectsLikely && <p className="border-l-4 border-bill pl-3 text-body">This might change data on your server.</p>}
              {isOn && needsNoSideEffectConfirmation(op) && (
                <label className="flex cursor-pointer items-center gap-2 text-body">
                  <input type="checkbox" aria-label={`${label} changes nothing on my server`} checked={confirmed.has(op.id)} disabled={busy}
                    onChange={(e) => setConfirmed((prev) => withItem(prev, op.id, e.target.checked))} />
                  I confirm this endpoint changes nothing on my server.
                </label>
              )}
              {isOn && (
                <label className="flex cursor-pointer items-center gap-2 text-body">
                  <input type="radio" name="escrow-op" aria-label={`Use ${label} for per-job hires`} checked={escrow === op.id} disabled={busy}
                    onChange={() => setEscrow(op.id)} />
                  Use this endpoint for per-job hires (Masumi escrow).
                </label>
              )}
            </li>
          );
        })}
      </ul>
      {problem && <p className="text-body text-graphite">{problem}</p>}
      {error && <InlineError>{error}</InlineError>}
      <Button disabled={problem !== null} pending={busy} pendingLabel="Saving your choice…" onClick={submit}>Confirm endpoints</Button>
    </div>
  );
}
