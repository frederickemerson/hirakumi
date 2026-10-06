"use client";

import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { coerceInput, type TryField, type TryKind, type TryResult } from "@/lib/try";
import { cn } from "@/lib/utils";

export type TryOp = {
  opId: string;
  method: string;
  path: string;
  description: string | null;
  promise: string | null;
  fields: TryField[];
};

type Outcome = {
  status: number;
  latencyMs: number;
  creditsRemaining: number | null;
  result: TryResult;
  body: unknown;
  request: { method: string; url: string };
  paid: boolean;
  at: string;
};

/** What the gateway is doing while we wait, so the visitor never stares at a frozen button. */
export const STAGES = ["Checking the credit", "Calling the API", "Checking the answer against the promise"] as const;

export function stageAt(elapsedMs: number): number {
  return elapsedMs < 400 ? 0 : elapsedMs < 1800 ? 1 : 2;
}

/* The outcome card takes the verdict's colour from the house palette: mint kept, canary refused, coral down. */
const KIND_STYLE: Record<TryKind, string> = {
  kept: "bg-mint/25",
  not_kept: "bg-canary",
  payment_required: "bg-ice",
  down: "bg-coral/40",
  invalid_input: "bg-canary",
  error: "bg-coral/40",
};

const FIELD =
  "block w-full rounded-[2px] border-2 border-ink bg-frost text-body text-ink outline-none transition-colors duration-100 focus-visible:border-sky";

export function TryConsole({ apiId, ops, hasDemoCredits }: { apiId: string; ops: TryOp[]; hasDemoCredits: boolean }) {
  const [opIndex, setOpIndex] = useState(0);
  const op = ops[opIndex];
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(op));
  const [busy, setBusy] = useState<null | { paid: boolean; startedAt: number }>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<Outcome[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  if (!op) return <p className="text-body text-graphite">This API has no endpoints open for buyers yet.</p>;

  function pickOp(i: number) {
    setOpIndex(i);
    setValues(initialValues(ops[i]));
  }

  async function run(paid: boolean) {
    setError(null);
    const coerced = coerceInput(op.fields, values);
    if (!coerced.ok) {
      setError(coerced.error);
      return;
    }
    const startedAt = Date.now();
    setBusy({ paid, startedAt });
    setElapsed(0);
    timer.current = setInterval(() => setElapsed(Date.now() - startedAt), 100);
    try {
      const res = await fetch(`/api/try/${encodeURIComponent(apiId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ opId: op.opId, method: op.method, input: coerced.input, paid }),
      });
      const data = (await res.json()) as Omit<Outcome, "paid" | "at"> & { error?: string };
      if (!res.ok) {
        setError(data.error ?? `Something went wrong (HTTP ${res.status}).`);
        return;
      }
      setHistory((h) => [{ ...data, paid, at: new Date().toLocaleTimeString() }, ...h].slice(0, 6));
    } catch {
      setError("We couldn't reach Hirakumi. Check your connection and try again.");
    } finally {
      if (timer.current) clearInterval(timer.current);
      setBusy(null);
    }
  }

  const latest = history[0];
  const stage = stageAt(elapsed);
  const progress = busy ? (busy.paid ? ((stage + 1) / 3) * 0.9 : Math.min(0.9, elapsed / 2000)) : 0;

  return (
    <div className="space-y-6">
      {ops.length > 1 && (
        <div role="radiogroup" aria-label="Endpoint" className="flex flex-wrap gap-2">
          {ops.map((o, i) => (
            <Button key={o.opId} type="button" variant={i === opIndex ? "default" : "outline"} aria-pressed={i === opIndex} onClick={() => pickOp(i)}>
              {o.method.toUpperCase()} {o.path}
            </Button>
          ))}
        </div>
      )}

      <div className="rounded-[2px] border-2 border-ink bg-frost p-5 sm:p-6">
        <p className="flex flex-wrap items-center gap-2 text-body-lg">
          <Badge variant="sky">{op.method.toUpperCase()}</Badge>
          <code>{op.path}</code>
        </p>
        {op.description && <p className="mt-3 text-body text-graphite">{op.description}</p>}
        {op.promise && (
          <p className="mt-4 border-t border-ink pt-4 text-body">
            <span className="font-semibold">Promise: </span>
            {op.promise}
          </p>
        )}

        <form
          className="mt-6 space-y-5 border-t border-ink pt-6"
          onSubmit={(e) => { e.preventDefault(); if (!busy) void run(hasDemoCredits); }}
        >
          {op.fields.length === 0 && <p className="text-body text-graphite">This endpoint takes no input.</p>}
          {op.fields.map((f) => (
            <label key={f.name} className="block space-y-2">
              <span className="block text-caption font-semibold uppercase tracking-[0.04em]">
                {f.name}{f.required ? "" : " (optional)"}
              </span>
              {f.options ? (
                <select
                  className={cn(FIELD, "h-11 max-w-xs px-3")}
                  value={values[f.name] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                >
                  {!f.required && <option value="">(none)</option>}
                  {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : f.json ? (
                <textarea
                  className={cn(FIELD, "min-h-24 p-3 text-caption leading-relaxed")}
                  value={values[f.name] ?? ""}
                  placeholder={f.example}
                  onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                />
              ) : (
                <Input
                  className="max-w-xs"
                  value={values[f.name] ?? ""}
                  placeholder={f.example}
                  onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                />
              )}
              {f.description && <span className="block text-caption text-graphite">{f.description}</span>}
            </label>
          ))}
          <div className="flex flex-wrap gap-4 pt-1">
            {hasDemoCredits && (
              <Button type="submit" disabled={!!busy}>
                {busy?.paid ? "Calling…" : "Call it with a demo credit"}
              </Button>
            )}
            <Button type="button" variant="outline" disabled={!!busy} onClick={() => void run(false)}>
              {busy && !busy.paid ? "Asking…" : "See what an unpaid agent gets"}
            </Button>
          </div>
        </form>
      </div>

      {busy && (
        <div aria-live="polite" className="space-y-3 rounded-[2px] border-2 border-ink bg-frost p-5">
          <div className="flex justify-between gap-4 text-body">
            <span className="font-medium">{busy.paid ? STAGES[stage] : "Asking the gateway for its price"}…</span>
            <span className="tabular-nums text-graphite">{(elapsed / 1000).toFixed(1)}s</span>
          </div>
          <div className="h-2.5 overflow-hidden rounded-[2px] border border-ink bg-chalk" role="progressbar" aria-valuemin={0} aria-valuemax={3} aria-valuenow={stage + 1}>
            <div className="h-full w-full origin-left stripes-sky transition-transform duration-300 ease-[var(--ease-snap)]" style={{ transform: `scaleX(${progress})` }} />
          </div>
          {busy.paid && (
            <ol className="flex flex-wrap gap-x-5 gap-y-1 text-caption uppercase tracking-[0.04em] text-graphite">
              {STAGES.map((s, i) => <li key={s} className={i <= stage ? "text-ink" : ""}>{i < stage ? "✓ " : ""}{s}</li>)}
            </ol>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-[2px] border-2 border-ink border-l-8 border-l-coral bg-frost p-4 text-body">
          {error}
        </p>
      )}

      {latest && !busy && (
        <div className={cn("space-y-4 rounded-[2px] border-2 border-ink p-5 shadow-hard sm:p-6", KIND_STYLE[latest.result.kind])} aria-live="polite">
          <p className="text-body-lg font-semibold">{latest.result.headline}</p>
          <dl className="grid grid-cols-3 gap-3 border-t border-ink pt-4 text-body">
            <div>
              <dt className="text-caption uppercase tracking-[0.04em] text-graphite">HTTP</dt>
              <dd className="text-h-sm font-medium tabular-nums">{latest.status}</dd>
            </div>
            <div>
              <dt className="text-caption uppercase tracking-[0.04em] text-graphite">Time</dt>
              <dd className="text-h-sm font-medium tabular-nums">{latest.latencyMs} ms</dd>
            </div>
            <div>
              <dt className="text-caption uppercase tracking-[0.04em] text-graphite">Credits left</dt>
              <dd className="text-h-sm font-medium tabular-nums">{latest.creditsRemaining ?? "n/a"}</dd>
            </div>
          </dl>
          {latest.result.reasons.length > 0 && (
            <ul className="list-disc pl-5 text-body">{latest.result.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
          )}
          <p className="break-all text-caption text-graphite">{latest.request.method} {latest.request.url}</p>
          <pre className="max-h-80 overflow-auto rounded-[2px] border border-ink bg-frost p-3 text-caption leading-relaxed"><code>{typeof latest.body === "string" ? latest.body : JSON.stringify(latest.body, null, 2)}</code></pre>
        </div>
      )}

      {history.length > 1 && (
        <div className="space-y-2">
          <h3 className="text-caption font-semibold uppercase tracking-[0.04em]">Earlier calls</h3>
          <ul className="divide-y divide-silver text-caption text-graphite">
            {history.slice(1).map((h, i) => (
              <li key={`${h.at}-${i}`} className="flex flex-wrap gap-x-4 gap-y-1 py-2">
                <span className="tabular-nums">{h.at}</span>
                <span>{h.paid ? "paid" : "unpaid"}</span>
                <span>HTTP {h.status}</span>
                <span className="tabular-nums">{h.latencyMs} ms</span>
                <span className="text-ink">{h.result.headline}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function initialValues(op: TryOp | undefined): Record<string, string> {
  if (!op) return {};
  return Object.fromEntries(op.fields.map((f) => [f.name, f.options?.[0] ?? (f.required ? f.example : "")]));
}
