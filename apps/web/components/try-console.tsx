"use client";

import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { offerHeadline, parseOffer, type Offer } from "@/lib/offer";
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

/** Each block of a fresh result rises in turn, 60 ms apart (CSS animate-rise; still under reduced motion). */
const stagger = (i: number) => ({ animationDelay: `${i * 60}ms` });

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function TryConsole({ apiId, ops, hasDemoCredits, initialCredits = null }: {
  apiId: string;
  ops: TryOp[];
  hasDemoCredits: boolean;
  /** Demo credits left when the page loaded; updated from each answer's creditsRemaining. */
  initialCredits?: number | null;
}) {
  const [opIndex, setOpIndex] = useState(0);
  const op = ops[opIndex];
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(op));
  const [busy, setBusy] = useState<null | { paid: boolean; startedAt: number }>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<Outcome[]>([]);
  const [credits, setCredits] = useState<number | null>(initialCredits);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const slot = useRef<HTMLDivElement>(null);

  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  if (!op) return <p className="text-body text-graphite">This API has no endpoints open for buyers yet.</p>;

  function pickOp(i: number) {
    setOpIndex(i);
    setValues(initialValues(ops[i]));
  }

  /** On a narrow screen the result slot sits under the form: bring it into view when a call starts. */
  function revealSlot() {
    const el = slot.current;
    if (!el || typeof window.matchMedia !== "function" || !window.matchMedia("(max-width: 1023px)").matches) return;
    el.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
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
    revealSlot();
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
      if (typeof data.creditsRemaining === "number") setCredits(data.creditsRemaining);
      setHistory((h) => [{ ...data, paid, at: new Date().toLocaleTimeString() }, ...h].slice(0, 6));
    } catch {
      setError("We couldn't reach Hirakumi. Check your connection and try again.");
    } finally {
      if (timer.current) clearInterval(timer.current);
      setBusy(null);
    }
  }

  const latest = history[0];
  const offer = latest?.result.kind === "payment_required" ? parseOffer(latest.body) : null;

  return (
    <div className="space-y-8">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
        <div className="min-w-0 space-y-4">
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
              <div className="flex flex-col gap-4 pt-1 sm:flex-row sm:flex-wrap">
                {hasDemoCredits && (
                  <Button type="submit" disabled={!!busy}>
                    {busy?.paid ? "Calling…" : "Call it with a demo credit"}
                  </Button>
                )}
                <Button type="button" variant="outline" disabled={!!busy} onClick={() => void run(false)}>
                  {busy && !busy.paid ? "Calling…" : "See what an unpaid agent gets"}
                </Button>
              </div>
              {hasDemoCredits && credits !== null && (
                <p className="text-caption text-graphite">
                  Demo credits left: <span className="font-semibold tabular-nums text-ink">{credits}</span>
                </p>
              )}
            </form>
          </div>
        </div>

        {/* The result slot keeps its height, so a result lands in place instead of pushing the page. */}
        <div ref={slot} aria-live="polite" className="min-w-0 scroll-mt-6 lg:sticky lg:top-6">
          <div className="min-h-[22rem]">
            {busy ? (
              <div className="flex min-h-[22rem] flex-col items-center justify-center gap-3 rounded-[2px] border-2 border-ink bg-frost p-6 text-center">
                <p className="flex items-center gap-3 text-body-lg font-medium">
                  <Spinner className="size-3.5" />
                  Calling…
                </p>
                <p className="text-body text-graphite tabular-nums">{(elapsed / 1000).toFixed(1)} s</p>
              </div>
            ) : error ? (
              <p role="alert" className="rounded-[2px] border-2 border-ink border-l-8 border-l-coral bg-frost p-4 text-body animate-rise">
                {error}
              </p>
            ) : latest ? (
              <div key={`${latest.at}-${history.length}`} className={cn("space-y-4 rounded-[2px] border-2 border-ink p-5 shadow-hard sm:p-6", KIND_STYLE[latest.result.kind])}>
                <p style={stagger(0)} className="animate-rise text-body-lg font-semibold">{latest.result.headline}</p>
                {offer ? (
                  <OfferCard offer={offer} body={latest.body} />
                ) : (
                  <>
                    <dl style={stagger(1)} className="animate-rise grid grid-cols-3 gap-3 border-t border-ink pt-4 text-body">
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
                      <ul style={stagger(2)} className="animate-rise list-disc pl-5 text-body">{latest.result.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
                    )}
                    <div style={stagger(3)} className="animate-rise space-y-2">
                      <p className="break-all text-caption text-graphite">{latest.request.method} {latest.request.url}</p>
                      <pre className="max-h-72 overflow-auto rounded-[2px] border border-ink bg-frost p-3 text-caption leading-relaxed"><code>{typeof latest.body === "string" ? latest.body : JSON.stringify(latest.body, null, 2)}</code></pre>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="flex min-h-[22rem] flex-col items-center justify-center gap-2 rounded-[2px] border-2 border-dashed border-graphite p-6 text-center">
                <p className="font-medium">The answer appears here.</p>
                <p className="max-w-xs text-body text-graphite">
                  {hasDemoCredits
                    ? "A paid try uses one demo credit, only if the answer keeps the promise."
                    : "An unpaid try shows the offer a buying agent gets."}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

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

/** The 402 offer as an agent would read it: what a pack costs and what it buys, with the raw answer on request. */
function OfferCard({ offer, body }: { offer: Offer; body: unknown }) {
  return (
    <>
      <ul style={stagger(1)} className="animate-rise space-y-3 border-t border-ink pt-4">
        {offer.packs.map((p) => (
          <li key={p.packId} className="rounded-[2px] border-2 border-ink bg-frost p-4">
            <p className="text-h-sm font-medium tabular-nums">{offerHeadline(p)}</p>
            <p className="mt-1 text-body text-graphite">
              Paid once on Cardano preprod. A credit is used only when the answer keeps the promise.
            </p>
            {p.buyUrl && <p className="mt-3 break-all text-caption text-graphite">Buy at {p.buyUrl}</p>}
          </li>
        ))}
      </ul>
      {offer.ruleUrl && (
        <a style={stagger(2)} href={offer.ruleUrl} target="_blank" rel="noreferrer" className="animate-rise inline-block text-body underline underline-offset-4">
          The promise the answer is checked against (JSON)
        </a>
      )}
      <details style={stagger(3)} className="animate-rise">
        <summary className="cursor-pointer py-1 text-body underline underline-offset-4">Show the raw 402 answer</summary>
        <pre className="mt-2 max-h-72 overflow-auto rounded-[2px] border border-ink bg-frost p-3 text-caption leading-relaxed"><code>{JSON.stringify(body, null, 2)}</code></pre>
      </details>
    </>
  );
}

function initialValues(op: TryOp | undefined): Record<string, string> {
  if (!op) return {};
  return Object.fromEntries(op.fields.map((f) => [f.name, f.options?.[0] ?? (f.required ? f.example : "")]));
}
