"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { coerceInput, type TryField, type TryKind, type TryResult } from "@/lib/try";

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

const KIND_STYLE: Record<TryKind, string> = {
  kept: "border-emerald-600 bg-emerald-50",
  not_kept: "border-amber-500 bg-amber-50",
  payment_required: "border-sky-500 bg-sky-50",
  down: "border-red-500 bg-red-50",
  invalid_input: "border-amber-500 bg-amber-50",
  error: "border-red-500 bg-red-50",
};

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

  if (!op) return <p className="text-muted-foreground">This API has no endpoints open for buyers yet.</p>;

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

  return (
    <div className="space-y-6">
      {ops.length > 1 && (
        <div role="radiogroup" aria-label="Endpoint" className="flex flex-wrap gap-2">
          {ops.map((o, i) => (
            <Button key={o.opId} type="button" variant={i === opIndex ? "default" : "outline"} aria-pressed={i === opIndex} onClick={() => pickOp(i)}>
              <span className="font-mono">{o.method.toUpperCase()} {o.path}</span>
            </Button>
          ))}
        </div>
      )}

      <div className="space-y-1">
        <p className="font-mono text-sm">{op.method.toUpperCase()} {op.path}</p>
        {op.description && <p className="text-sm text-muted-foreground">{op.description}</p>}
        {op.promise && <p className="text-sm"><span className="font-medium">Promise: </span>{op.promise}</p>}
      </div>

      <form
        className="space-y-4"
        onSubmit={(e) => { e.preventDefault(); if (!busy) void run(hasDemoCredits); }}
      >
        {op.fields.length === 0 && <p className="text-sm text-muted-foreground">This endpoint takes no input.</p>}
        {op.fields.map((f) => (
          <label key={f.name} className="block space-y-1">
            <span className="text-sm font-medium">{f.name}{f.required ? "" : " (optional)"}</span>
            {f.options ? (
              <select
                className="block h-9 w-full max-w-xs rounded-md border bg-background px-2 text-sm"
                value={values[f.name] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
              >
                {!f.required && <option value="">(none)</option>}
                {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : f.json ? (
              <textarea
                className="block min-h-24 w-full rounded-md border bg-background p-2 font-mono text-xs"
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
            {f.description && <span className="block text-xs text-muted-foreground">{f.description}</span>}
          </label>
        ))}
        <div className="flex flex-wrap gap-3">
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

      {busy && (
        <div aria-live="polite" className="space-y-2 rounded-md border p-4">
          <div className="flex justify-between text-sm">
            <span>{busy.paid ? STAGES[stage] : "Asking the gateway for its price"}…</span>
            <span className="font-mono tabular-nums">{(elapsed / 1000).toFixed(1)}s</span>
          </div>
          <div className="h-2 overflow-hidden rounded-sm bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={3} aria-valuenow={stage + 1}>
            <div className="h-full bg-sky-400 transition-[width] duration-300" style={{ width: `${busy.paid ? ((stage + 1) / 3) * 90 : Math.min(90, elapsed / 20)}%` }} />
          </div>
          {busy.paid && (
            <ol className="flex flex-wrap gap-x-4 text-xs text-muted-foreground">
              {STAGES.map((s, i) => <li key={s} className={i <= stage ? "text-foreground" : ""}>{i < stage ? "✓ " : ""}{s}</li>)}
            </ol>
          )}
        </div>
      )}

      {error && <p role="alert" className="rounded-md border border-red-500 bg-red-50 p-3 text-sm">{error}</p>}

      {latest && !busy && (
        <div className={`space-y-3 rounded-md border-2 p-4 ${KIND_STYLE[latest.result.kind]}`} aria-live="polite">
          <p className="font-medium">{latest.result.headline}</p>
          <dl className="grid grid-cols-3 gap-2 text-sm">
            <div><dt className="text-muted-foreground">HTTP</dt><dd className="font-mono">{latest.status}</dd></div>
            <div><dt className="text-muted-foreground">Time</dt><dd className="font-mono">{latest.latencyMs} ms</dd></div>
            <div><dt className="text-muted-foreground">Credits left</dt><dd className="font-mono">{latest.creditsRemaining ?? "–"}</dd></div>
          </dl>
          {latest.result.reasons.length > 0 && (
            <ul className="list-disc pl-5 text-sm">{latest.result.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
          )}
          <p className="break-all font-mono text-xs text-muted-foreground">{latest.request.method} {latest.request.url}</p>
          <pre className="max-h-80 overflow-auto rounded-sm bg-white/70 p-3 text-xs"><code>{typeof latest.body === "string" ? latest.body : JSON.stringify(latest.body, null, 2)}</code></pre>
        </div>
      )}

      {history.length > 1 && (
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Earlier calls</h3>
          <ul className="text-xs text-muted-foreground">
            {history.slice(1).map((h, i) => (
              <li key={`${h.at}-${i}`} className="font-mono">{h.at} · {h.paid ? "paid" : "unpaid"} · HTTP {h.status} · {h.latencyMs} ms · {h.result.headline}</li>
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
