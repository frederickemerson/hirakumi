"use client";

import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { motionAllowed } from "@/lib/motion";
import { cn } from "@/lib/utils";

gsap.registerPlugin(useGSAP);

type Row = { answer: string; verdict: string; variant: "mint" | "default" | "destructive"; credit: string; left: number };

const PACK = 100;

/* Four paid calls against the demo API's promise. The stale and down cases are what was measured on preprod. */
const ROWS: Row[] = [
  { answer: "fresh", verdict: "pass", variant: "mint", credit: "−1", left: 99 },
  { answer: "1 h old", verdict: "422 stale", variant: "default", credit: "0", left: 99 },
  { answer: "no answer", verdict: "503 down", variant: "destructive", credit: "0", left: 99 },
  { answer: "fresh", verdict: "pass", variant: "mint", credit: "−1", left: 98 },
];
const FINAL = ROWS[ROWS.length - 1].left;

/** Rows land one after another once the card is up; the credit counter ticks as each one lands. */
const ROW_START_MS = 620;
const ROW_STEP_MS = 170;
const rowDelay = (i: number) => `${ROW_START_MS + i * ROW_STEP_MS}ms`;

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="shrink-0 text-caption uppercase tracking-[0.04em] text-graphite">{label}</dt>
      <span aria-hidden className="mb-[0.3em] min-w-4 flex-1 self-end border-b border-dotted border-silver" />
      <dd className="text-right">{children}</dd>
    </div>
  );
}

/**
 * The hero visual: a buyer's receipt for a call pack. Credits move only when an answer keeps the
 * promise. Rows rise in sequence with CSS (no flash before hydration); the counter ticks with GSAP.
 * With reduced motion everything is simply shown in its final state.
 */
export function Receipt({ className }: { className?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const counter = useRef<HTMLSpanElement>(null);

  useGSAP(
    () => {
      const el = counter.current;
      if (!el || !motionAllowed()) return;
      const n = { v: PACK };
      el.textContent = String(PACK);
      const tl = gsap.timeline({ delay: ROW_START_MS / 1000 });
      let prev = PACK;
      ROWS.forEach((r, i) => {
        if (r.left === prev) return;
        prev = r.left;
        const at = (i * ROW_STEP_MS) / 1000 + 0.22;
        tl.to(n, { v: r.left, duration: 0.18, snap: "v", onUpdate: () => { el.textContent = String(Math.round(n.v)); } }, at);
        tl.fromTo(el, { scale: 1.08 }, { scale: 1, duration: 0.3, ease: "power2.out" }, at);
      });
    },
    { scope: root },
  );

  return (
    <figure ref={root} className={cn("relative", className)}>
      <div className="rounded-[2px] border-2 border-ink bg-frost shadow-hard-lg">
        <div className="flex items-center justify-between gap-4 border-b-2 border-ink px-5 py-3">
          <p className="text-caption font-semibold uppercase tracking-[0.06em]">Buyer receipt</p>
          <Badge variant="outline">Cardano preprod</Badge>
        </div>

        <dl className="px-5 pt-4 pb-4 text-body">
          <div className="space-y-2">
            <Line label="Pack">{`${PACK} calls for 2.00 tUSDM`}</Line>
            <Line label="Paid to">seller wallet in 16.5 s</Line>
          </div>
          <div className="mt-3 border-t border-dotted border-silver pt-3">
            <dt className="text-caption uppercase tracking-[0.04em] text-graphite">
              A good answer to <span className="font-medium text-ink">GET /price</span> has
            </dt>
            <dd className="mt-1">symbol, usd, change24h and a timestamp under 15 min old</dd>
          </div>
        </dl>

        <ol className="border-t-2 border-dashed border-ink px-5 py-3 text-body" aria-label="Paid calls">
          {ROWS.map((r, i) => (
            <li
              key={i}
              className="grid grid-cols-[auto_1fr_auto_2.5rem] items-center gap-x-3 py-2 animate-rise"
              style={{ animationDelay: rowDelay(i) }}
            >
              <span className="font-medium">GET /price</span>
              <span className="truncate text-graphite">{r.answer}</span>
              <Badge variant={r.variant}>{r.verdict}</Badge>
              <span className="text-right tabular-nums">{r.credit}</span>
            </li>
          ))}
        </ol>

        <div className="flex items-center justify-between gap-4 border-t-2 border-dashed border-ink px-5 py-4">
          <p className="text-caption font-semibold uppercase tracking-[0.06em]">Credits left</p>
          <p className="text-h font-light leading-none tabular-nums">
            <span ref={counter} className="inline-block origin-right">{FINAL}</span>
            <span className="text-body-lg text-graphite">{` / ${PACK}`}</span>
          </p>
        </div>
      </div>
      <figcaption className="mt-4 text-body text-graphite">
        Every answer is checked against that rule before a credit is used. Stale, empty and failed answers are free.
      </figcaption>
    </figure>
  );
}
