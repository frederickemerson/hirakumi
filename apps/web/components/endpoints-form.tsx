"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { postJson, RequestError } from "@/lib/client-fetch";
import { needsNoSideEffectConfirmation, validateEndpointSelection, type EndpointSelection } from "@/lib/endpoints";
import type { Operation } from "@/lib/types";

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
      router.push(`/apis/${apiId}/ownership`);
    } catch (e) {
      setError(e instanceof RequestError ? e.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Every endpoint starts blocked. Tick the ones agents may buy. Only sell endpoints that read data and change nothing.
      </p>
      <ul className="divide-y rounded-lg border">
        {operations.map((op) => {
          const label = `${op.method.toUpperCase()} ${op.path}`;
          const isOn = enabled.has(op.id);
          return (
            <li key={op.id} className="space-y-2 p-4">
              <label className="flex items-center gap-3">
                <input type="checkbox" aria-label={`Sell ${label}`} checked={isOn}
                  onChange={(e) => toggleEnabled(op.id, e.target.checked)} />
                <Badge variant="outline">{op.method.toUpperCase()}</Badge>
                <code>{op.path}</code>
              </label>
              <p className="text-sm text-muted-foreground">{op.description ?? "No description yet."}</p>
              {op.sideEffectsLikely && <p className="text-sm text-amber-700">This might change data on your server.</p>}
              {isOn && needsNoSideEffectConfirmation(op) && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" aria-label={`${label} changes nothing on my server`} checked={confirmed.has(op.id)}
                    onChange={(e) => setConfirmed((prev) => withItem(prev, op.id, e.target.checked))} />
                  I confirm this endpoint changes nothing on my server.
                </label>
              )}
              {isOn && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="radio" name="escrow-op" aria-label={`Use ${label} for per-job hires`} checked={escrow === op.id}
                    onChange={() => setEscrow(op.id)} />
                  Use this endpoint for per-job hires (Masumi escrow).
                </label>
              )}
            </li>
          );
        })}
      </ul>
      {problem && <p className="text-sm text-muted-foreground">{problem}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button disabled={problem !== null || busy} onClick={submit}>{busy ? "Saving…" : "Confirm endpoints"}</Button>
    </div>
  );
}
