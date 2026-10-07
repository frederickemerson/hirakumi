"use client";

import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { answerFormatLabel, isJsonMediaType } from "@/lib/answer-format";
import { formatTusdm } from "@/lib/money";
import { coerceInput, type TryField, type TryKind, type TryReceipt, type TryResult } from "@/lib/try";
import { cardanoscanTx, readBuyEvents, type BuyEvent } from "@/lib/try-stream";
import { settlementLine } from "@/lib/settlement";
import { cn } from "@/lib/utils";
import { StatusOnlyNote } from "@/components/status-only-note";

export type TryOp = {
  opId: string;
  method: string;
  path: string;
  description: string | null;
  promise: string | null;
  /** The promise checks only the status and error pages (StatusOnlyNote). */
  statusOnly?: boolean;
  fields: TryField[];
};

/** The pack the page's calls pay with, as the server saw it. The token itself never reaches the browser. */
export type TryPackView = { credits: number; txHash: string | null; pending: boolean };

type Outcome = {
  status: number;
  latencyMs: number;
  creditsRemaining: number | null;
  result: TryResult;
  receipt: TryReceipt;
  body: unknown;
  /** The answer's media type ("text/csv"), or null when the gateway sent none. */
  contentType?: string | null;
  request: { method: string; url: string };
  at: string;
};

/** Live progress of "Buy a pack live", from the gateway's stream. Times are Date.now() values. */
type Purchase =
  | { phase: "paying"; startedAt: number }
  | { phase: "settling"; startedAt: number; settlingAt: number }
  | { phase: "settled"; startedAt: number; ms: number; txHash: string | null; credits: number; recovered: boolean }
  | { phase: "ready"; txHash: string | null; credits: number }
  | { phase: "failed"; startedAt: number; message: string; spent: boolean };

/* The outcome card takes the verdict's colour from the house palette: mint kept, canary refused, coral down. */
const KIND_STYLE: Record<TryKind, string> = {
  kept: "bg-mint/25",
  not_kept: "bg-canary",
  used_up: "bg-ice",
  pending: "bg-ice",
  down: "bg-coral/40",
  invalid_input: "bg-canary",
  error: "bg-coral/40",
};

const VERDICT_LABEL: Record<TryReceipt["verdict"], string> = { kept: "Kept", not_kept: "Not kept", no_charge: "No charge" };

const FIELD =
  "block w-full rounded-[2px] border-2 border-ink bg-frost text-body text-ink outline-none transition-colors duration-100 focus-visible:border-sky";

/** No event from the purchase for this long means the connection is gone (a payment takes 20 to 60 s). */
const BUY_STALL_MS = 100_000;
const CALL_TIMEOUT_MS = 35_000;

/** Each block of a fresh result rises in turn, 60 ms apart (CSS animate-rise; still under reduced motion). */
const stagger = (i: number) => ({ animationDelay: `${i * 60}ms` });
const seconds = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)} s`;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function TryConsole({ apiId, ops, initialPack, packPrice = null, downReason = null, liveBuy = false, paths, noPackNote, noPackHint, buyNote, buyLabel, onPackChange }: {
  apiId: string;
  ops: TryOp[];
  /** A pack with credits left when the page loaded, or null: then the first step is "Buy a pack live". */
  initialPack: TryPackView | null;
  /** What a pack costs, for the buy button's note. */
  packPrice?: { calls: number; priceMicros: string } | null;
  /** Set when the API is Down: every action is disabled and this says why. */
  downReason?: string | null;
  /** A featured API (TRY_LIVE_APIS): the demo wallet may buy it a pack. Elsewhere only an existing pack is used. */
  liveBuy?: boolean;
  /** Where calls and the demo purchase go; default the public routes. The seller's own Try it live has its own. */
  paths?: { call: string; buy: string };
  /** Shown instead of the buy button when there is no pack and no demo purchase (the seller's wallet payment). */
  noPackNote?: React.ReactNode;
  /** Replaces "Buy a pack live" on the first step (the seller's free test). */
  buyLabel?: string;
  /** Replaces the note under "Buy a pack live". */
  buyNote?: React.ReactNode;
  /** The empty result slot's hint when there is no pack and no demo purchase. */
  noPackHint?: string;
  /** Told when the pack's credits change or it runs out (null). */
  onPackChange?: (pack: TryPackView | null) => void;
}) {
  const callPath = paths?.call ?? `/api/try/${encodeURIComponent(apiId)}`;
  const buyPath = paths?.buy ?? `/api/try/${encodeURIComponent(apiId)}/buy`;
  const [opIndex, setOpIndex] = useState(0);
  const op = ops[opIndex];
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(op));
  const [busy, setBusy] = useState<null | "buy" | "call">(null);
  const [callStartedAt, setCallStartedAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<Outcome[]>([]);
  const [pack, setPackState] = useState<TryPackView | null>(initialPack);
  const onPackRef = useRef(onPackChange);
  onPackRef.current = onPackChange;
  const setPack = (next: TryPackView | null | ((p: TryPackView | null) => TryPackView | null)) => {
    setPackState((p) => {
      const v = typeof next === "function" ? next(p) : next;
      if (v !== p) queueMicrotask(() => onPackRef.current?.(v));
      return v;
    });
  };
  const [purchase, setPurchase] = useState<Purchase | null>(null);
  const [settlement, setSettlement] = useState<{ mode: "direct" | "escrow"; reasons: string[] } | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const slot = useRef<HTMLDivElement>(null);

  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  if (!op) return <p className="text-body text-graphite">This API has no endpoints open for buyers yet.</p>;

  const hasCredits = pack !== null && pack.credits > 0;
  const down = downReason !== null;
  /** Not featured and no pack left: nothing to run here, the buyer snippet shows how an agent pays. */
  const noLive = !hasCredits && !liveBuy;

  function pickOp(i: number) {
    setOpIndex(i);
    setValues(initialValues(ops[i]));
  }

  /** On a narrow screen the result slot sits under the form: bring it into view when work starts. */
  function revealSlot() {
    const el = slot.current;
    if (!el || typeof window.matchMedia !== "function" || !window.matchMedia("(max-width: 1023px)").matches) return;
    el.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  }

  function startTicker() {
    if (timer.current) clearInterval(timer.current);
    setNow(Date.now());
    timer.current = setInterval(() => setNow(Date.now()), 100);
  }
  function stopTicker() {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }

  async function call(input: Record<string, unknown>): Promise<void> {
    setBusy("call");
    setCallStartedAt(Date.now());
    try {
      const res = await fetch(callPath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ opId: op.opId, method: op.method, input }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      const data = (await res.json()) as Omit<Outcome, "at"> & { error?: string; needsPack?: boolean };
      if (!res.ok) {
        if (data.needsPack) setPack(null);
        setError(data.error ?? `Something went wrong (HTTP ${res.status}).`);
        return;
      }
      const left = data.receipt?.creditsLeft;
      if (data.result.kind === "used_up") setPack(null);
      else if (typeof left === "number") setPack((p) => (p ? { ...p, credits: left, pending: false } : p));
      setHistory((h) => [{ ...data, at: new Date().toLocaleTimeString() }, ...h].slice(0, 6));
    } catch {
      setError("No answer from Hirakumi. Check your connection and try again.");
    }
  }

  /** Real x402 purchase on Cardano preprod from the demo wallet, then the first call with the new pack. */
  async function buy(input: Record<string, unknown>): Promise<void> {
    const startedAt = Date.now();
    setBusy("buy");
    setPurchase({ phase: "paying", startedAt });
    setSettlement(null);
    const controller = new AbortController();
    let stall = setTimeout(() => controller.abort(), BUY_STALL_MS);
    const touch = () => { clearTimeout(stall); stall = setTimeout(() => controller.abort(), BUY_STALL_MS); };
    let bought: TryPackView | null = null;
    let finished = false;
    try {
      const res = await fetch(buyPath, { method: "POST", signal: controller.signal });
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setPurchase(null);
        setError(data.error ?? `The purchase failed (HTTP ${res.status}).`);
        return;
      }
      for await (const e of readBuyEvents(res.body)) {
        touch();
        const next = applyEvent(e, startedAt);
        if (next) setPurchase(next);
        if (e.phase === "settling" && e.settlement) setSettlement(e.settlement);
        if (e.phase === "settled" || e.phase === "ready") {
          bought = { credits: e.credits, txHash: e.txHash, pending: e.phase === "ready" ? e.pending : false };
          finished = true;
        }
        if (e.phase === "failed") finished = true;
      }
      if (!finished) throw new Error("stream ended early");
    } catch {
      setPurchase({ phase: "failed", startedAt, spent: false, message: "Lost the connection to the purchase. If it went through, reload in a minute to use the pack." });
    } finally {
      clearTimeout(stall);
    }
    if (bought) {
      setPack(bought);
      await call(input);
    }
  }

  async function run() {
    if (busy || down || noLive) return;
    setError(null);
    const coerced = coerceInput(op.fields, values);
    if (!coerced.ok) {
      setError(coerced.error);
      return;
    }
    startTicker();
    revealSlot();
    try {
      if (hasCredits) await call(coerced.input);
      else await buy(coerced.input);
    } finally {
      stopTicker();
      setBusy(null);
    }
  }

  const latest = history[0];
  const primaryLabel = hasCredits ? "Call it" : (buyLabel ?? "Buy a pack live");

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
            {op.statusOnly && <StatusOnlyNote className="mt-3" />}

            <form className="mt-6 space-y-5 border-t border-ink pt-6" onSubmit={(e) => { e.preventDefault(); void run(); }}>
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
              <div className="space-y-3 pt-1">
                {noLive && noPackNote ? noPackNote : noLive ? (
                  <p id="try-pack-note" role="note" className="text-body text-graphite">
                    Live purchases are funded by Hirakumi&apos;s demo wallet, so they&apos;re on featured APIs only.
                    Agents buy with their own wallet: see the{" "}
                    <a href={`/p/${encodeURIComponent(apiId)}#buyer-snippet`} className="underline underline-offset-4">code snippet</a>.
                  </p>
                ) : (<>
                <Button
                  type="submit"
                  size="lg"
                  disabled={down || (busy !== null)}
                  aria-busy={busy !== null || undefined}
                  aria-describedby={down ? "try-down-reason" : "try-pack-note"}
                  className={cn("w-full sm:w-auto", busy && "translate-x-[2px] translate-y-[2px] shadow-none")}
                >
                  {busy && <Spinner className="size-3" />}
                  {busy === "buy" ? "Buying a pack…" : busy === "call" ? "Calling…" : primaryLabel}
                </Button>
                {down ? (
                  <p id="try-down-reason" role="note" className="text-caption text-graphite">{downReason}</p>
                ) : (
                  <p id="try-pack-note" className="text-caption text-graphite">
                    {hasCredits ? (
                      <>
                        <span className="font-semibold tabular-nums text-ink">{pack.credits}</span> credits left in the live pack.
                        {pack.pending && " Its payment is still settling."}
                        {" "}A credit is used only when the answer keeps the promise.
                        {pack.txHash && (
                          <>
                            {" "}
                            <a href={cardanoscanTx(pack.txHash)} target="_blank" rel="noreferrer" className="underline underline-offset-4">Pack payment on Cardanoscan</a>
                          </>
                        )}
                      </>
                    ) : buyNote ? buyNote : (
                      <>
                        A real x402 payment{packPrice ? ` of ${formatTusdm(packPrice.priceMicros)} tUSDM for ${packPrice.calls} calls` : ""} on Cardano preprod,
                        from Hirakumi&apos;s demo wallet. Hirakumi settles it direct or in escrow and says why. Settles in 20 to 60 s, then
                        makes your call. In escrow the wallet signs for each answer it checked against the promise; the seller is paid only for those.
                      </>
                    )}
                  </p>
                )}
                </>)}
              </div>
            </form>
          </div>
        </div>

        {/* The result slot keeps its height, so progress and results land in place instead of pushing the page. */}
        <div ref={slot} aria-live="polite" className="min-w-0 scroll-mt-6 lg:sticky lg:top-6">
          <div className="flex min-h-[26rem] flex-col gap-4">
            {purchase && <PurchaseCard purchase={purchase} now={now} settlement={settlement} />}
            {busy === "call" ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-[2px] border-2 border-ink bg-frost p-6 text-center">
                <p className="flex items-center gap-3 text-body-lg font-medium">
                  <Spinner className="size-3.5" />
                  {`Calling ${op.method.toUpperCase()} ${op.path}`}
                </p>
                <p className="text-body text-graphite tabular-nums">{seconds(now - callStartedAt)}</p>
              </div>
            ) : error ? (
              <p role="alert" className="rounded-[2px] border-2 border-ink border-l-8 border-l-coral bg-frost p-4 text-body animate-rise">
                {error}
              </p>
            ) : latest ? (
              <ResultCard key={`${latest.at}-${history.length}`} outcome={latest} />
            ) : !purchase ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-[2px] border-2 border-dashed border-graphite p-6 text-center">
                <p className="font-medium">The answer and its receipt appear here.</p>
                <p className="max-w-xs text-body text-graphite">
                  {hasCredits
                    ? "Each call goes through the real gateway with a credit from the live pack."
                    : liveBuy ? "First buy a pack live, just like an agent would." : (noPackHint ?? "Live calls need a pack bought with an agent's own wallet.")}
                </p>
              </div>
            ) : null}
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
                <span>HTTP {h.status}</span>
                <span className="tabular-nums">{h.latencyMs} ms</span>
                <span>{VERDICT_LABEL[h.receipt.verdict]}</span>
                <span className="text-ink">{h.result.headline}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function applyEvent(e: BuyEvent, startedAt: number): Purchase | null {
  switch (e.phase) {
    case "paying": return { phase: "paying", startedAt };
    case "settling": return { phase: "settling", startedAt, settlingAt: Date.now() };
    case "settled": return { phase: "settled", startedAt, ms: e.ms > 0 ? e.ms : Date.now() - startedAt, txHash: e.txHash, credits: e.credits, recovered: e.recovered };
    case "ready": return { phase: "ready", txHash: e.txHash, credits: e.credits };
    case "failed": return { phase: "failed", startedAt, message: e.message, spent: e.spent };
    default: return null;
  }
}

type StepState = "todo" | "active" | "done" | "failed";

function Step({ state, label, time }: { state: StepState; label: React.ReactNode; time?: string }) {
  return (
    <li className={cn("flex min-h-8 items-center gap-3 text-body", state === "todo" && "text-graphite")} data-state={state}>
      <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
        {state === "active" ? <Spinner className="size-3" />
          : state === "done" ? <span className="size-3 bg-ink" />
          : state === "failed" ? <span className="size-3 bg-coral" />
          : <span className="size-3 border-2 border-graphite" />}
      </span>
      <span className="flex-1">{label}</span>
      {time && <span className="tabular-nums text-caption text-graphite">{time}</span>}
    </li>
  );
}

/** Paying, Settling on Cardano, Settled in N s: three fixed rows that change in place. */
function PurchaseCard({ purchase: p, now, settlement }: {
  purchase: Purchase; now: number; settlement?: { mode: "direct" | "escrow"; reasons: string[] } | null;
}) {
  if (p.phase === "ready") {
    return (
      <div className="rounded-[2px] border-2 border-ink bg-ice p-5 animate-rise">
        <p className="text-body-lg font-semibold">Using the live pack: {p.credits} credits left.</p>
        <p className="mt-1 text-body text-graphite">It still has credits, so nothing new was bought.</p>
        {p.txHash && <TxLink txHash={p.txHash} />}
      </div>
    );
  }
  const elapsed = p.phase === "settled" ? p.ms : now - p.startedAt;
  const paying: StepState = p.phase === "paying" ? "active" : p.phase === "failed" && !p.spent ? "failed" : "done";
  const settling: StepState = p.phase === "settling" ? "active" : p.phase === "settled" ? "done" : p.phase === "failed" && p.spent ? "failed" : "todo";
  const settled: StepState = p.phase === "settled" ? "done" : "todo";
  return (
    <div className="rounded-[2px] border-2 border-ink bg-frost p-5" data-testid="purchase">
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-body-lg font-semibold">Buying a pack live</p>
        <p className="tabular-nums text-body text-graphite" aria-label="Elapsed">{seconds(elapsed)}</p>
      </div>
      <ol className="mt-3 space-y-1">
        <Step state={paying} label="Paying from the demo wallet" />
        <Step state={settling} label="Settling on Cardano" time={p.phase === "settling" ? seconds(now - p.settlingAt) : undefined} />
        <Step state={settled} label={p.phase === "settled" ? `Settled in ${seconds(p.ms)}${p.recovered ? " (recovered)" : ""}` : "Settled"} />
      </ol>
      {settlement && <p className="mt-2 text-body text-graphite" data-testid="settlement">{settlementLine(settlement)}</p>}
      {p.phase === "settled" && (
        <div className="mt-3 border-t border-ink pt-3 animate-rise">
          <p className="text-body">{p.credits} credits bought.</p>
          {p.txHash && <TxLink txHash={p.txHash} />}
        </div>
      )}
      {p.phase === "failed" && <p role="alert" className="mt-3 border-t border-ink pt-3 text-body">{p.message}</p>}
    </div>
  );
}

function TxLink({ txHash }: { txHash: string }) {
  return (
    <a href={cardanoscanTx(txHash)} target="_blank" rel="noreferrer" className="mt-2 inline-block break-all text-body underline underline-offset-4">
      {`Tx ${txHash.slice(0, 10)}…${txHash.slice(-6)} on Cardanoscan`}
    </a>
  );
}

/** One call's answer and its receipt: verdict, credits left, output hash and the full receipts. */
function ResultCard({ outcome: o }: { outcome: Outcome }) {
  return (
    <div className={cn("space-y-4 rounded-[2px] border-2 border-ink p-5 shadow-hard sm:p-6", KIND_STYLE[o.result.kind])}>
      <p style={stagger(0)} className="animate-rise text-body-lg font-semibold">{o.result.headline}</p>
      <dl style={stagger(1)} className="animate-rise grid grid-cols-3 gap-3 border-t border-ink pt-4 text-body">
        <div>
          <dt className="text-caption uppercase tracking-[0.04em] text-graphite">Verdict</dt>
          <dd className="text-h-sm font-medium">{VERDICT_LABEL[o.receipt.verdict]}</dd>
        </div>
        <div>
          <dt className="text-caption uppercase tracking-[0.04em] text-graphite">Credits left</dt>
          <dd className="text-h-sm font-medium tabular-nums">{o.receipt.creditsLeft ?? "n/a"}</dd>
        </div>
        <div>
          <dt className="text-caption uppercase tracking-[0.04em] text-graphite">Time</dt>
          <dd className="text-h-sm font-medium tabular-nums">{o.latencyMs} ms</dd>
        </div>
      </dl>
      <div style={stagger(2)} className="animate-rise space-y-1 text-caption">
        <p className="uppercase tracking-[0.04em] text-graphite">Output hash</p>
        <p className="break-all font-mono" data-testid="output-hash">{o.receipt.outputHash ?? "None: no answer was paid for."}</p>
        <a href={o.receipt.receiptsUrl} target="_blank" rel="noreferrer" className="inline-block text-body underline underline-offset-4">
          See this pack&apos;s receipts
        </a>
      </div>
      {o.result.reasons.length > 0 && (
        <ul style={stagger(3)} className="animate-rise list-disc pl-5 text-body">{o.result.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
      )}
      <div style={stagger(4)} className="animate-rise space-y-2">
        <p className="break-all text-caption text-graphite">{o.request.method} {o.request.url}</p>
        {o.status === 200 && o.contentType && !isJsonMediaType(o.contentType) && (
          <p className="text-caption text-graphite" data-testid="answer-format">{`Answer format: ${answerFormatLabel(o.contentType)} (${o.contentType})`}</p>
        )}
        <pre className="max-h-60 overflow-auto rounded-[2px] border border-ink bg-frost p-3 text-caption leading-relaxed"><code>{typeof o.body === "string" ? o.body : JSON.stringify(o.body, null, 2)}</code></pre>
      </div>
    </div>
  );
}

function initialValues(op: TryOp | undefined): Record<string, string> {
  if (!op) return {};
  return Object.fromEntries(op.fields.map((f) => [f.name, f.options?.[0] ?? (f.required ? f.example : "")]));
}
