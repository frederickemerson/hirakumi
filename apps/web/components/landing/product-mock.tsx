"use client";

import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { useRef } from "react";
import { CloudDoodle, CoinDoodle, SmallCloudDoodle, TriangleDoodle } from "@/components/brand/doodles";
import { Floaters } from "@/components/landing/floaters";
import { motionAllowed, withScrollTrigger } from "@/lib/motion";
import { cn } from "@/lib/utils";

gsap.registerPlugin(useGSAP);

type Line =
  | { kind: "cmd" | "out" | "ok" | "code"; text: string }
  | { kind: "call"; method: string; result: string; verdict: "PASS" | "422"; credit: string; creditsAfter: number };

const PANES: { tab: string; title: string; lines: Line[] }[] = [
  {
    tab: "1 OpenAPI link",
    title: "paste a link",
    lines: [
      { kind: "cmd", text: "hirakumi add https://price.example.dev/openapi.json" },
      { kind: "out", text: "reading openapi.json … 6 operations found" },
      { kind: "out", text: "2 read-only endpoints look sellable" },
      { kind: "ok", text: "challenge file found at /.well-known/hirakumi" },
      { kind: "ok", text: "wallet signature verified (CIP-30)" },
    ],
  },
  {
    tab: "2 Promise",
    title: "review and price",
    lines: [
      { kind: "out", text: "test-calling GET /price, 5 times …" },
      { kind: "code", text: '"usd": { "type": "number" }' },
      { kind: "code", text: '"timestamp": { "maxAgeSeconds": 900 }' },
      { kind: "out", text: "you approve: 100 credits for 2.00 tUSDM" },
      { kind: "ok", text: "registered on Masumi, NFT minted on preprod" },
    ],
  },
  {
    tab: "3 Live",
    title: "agents buy",
    lines: [
      { kind: "ok", text: "pack bought: 2.00 tUSDM to your wallet, settled in 16.5 s" },
      { kind: "call", method: "GET /price", result: "200, fresh", verdict: "PASS", credit: "−1", creditsAfter: 99 },
      { kind: "call", method: "GET /price", result: "200, 1 h old", verdict: "422", credit: "0", creditsAfter: 99 },
      { kind: "call", method: "GET /price", result: "200, fresh", verdict: "PASS", credit: "−1", creditsAfter: 98 },
    ],
  },
];

const PACK = 100;
const FINAL_CREDITS = 98;

function LineRow({ line }: { line: Line }) {
  if (line.kind === "call") {
    return (
      <li data-line className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-cream">{line.method}</span>
        <span className="text-silver">{line.result}</span>
        <span
          className={cn(
            "rounded-[2px] border px-1.5 text-caption font-semibold",
            line.verdict === "PASS" ? "border-mint bg-mint/20 text-mint" : "border-canary bg-canary/20 text-canary",
          )}
        >
          {line.verdict === "PASS" ? "pass" : "422 stale"}
        </span>
        <span className="ml-auto tabular-nums text-silver">{`credit ${line.credit}`}</span>
      </li>
    );
  }
  return (
    <li
      data-line
      className={cn(
        "break-words",
        line.kind === "cmd" && "text-cream before:mr-2 before:text-sky before:content-['$']",
        line.kind === "out" && "text-silver",
        line.kind === "ok" && "text-mint before:mr-2 before:content-['✓']",
        line.kind === "code" && "pl-4 text-sky",
      )}
    >
      {line.text}
    </li>
  );
}

/**
 * The framed product mock: OpenAPI link → promise → live, with a credits counter that only moves
 * on a passing answer. On desktop the frame pins and the scroll position scrubs the story; on
 * small screens it plays once when it comes into view; with reduced motion it is simply shown.
 */
export function ProductMock() {
  const wrap = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const root = wrap.current;
      if (!root) return;
      const tabs = gsap.utils.toArray<HTMLElement>("[data-tab]", root);
      const panes = gsap.utils.toArray<HTMLElement>("[data-pane]", root);
      const credits = root.querySelector<HTMLElement>("[data-credits]");

      if (!motionAllowed()) {
        tabs.forEach((t) => t.setAttribute("data-active", "true"));
        if (credits) credits.textContent = String(FINAL_CREDITS);
        return;
      }

      withScrollTrigger();
      const ACTIVE = { backgroundColor: "#383838", color: "#f4efea" };
      const IDLE = { backgroundColor: "#ffffff", color: "#383838" };
      const counter = { value: PACK };

      function build(tl: gsap.core.Timeline) {
        panes.forEach((pane, i) => {
          const lines = gsap.utils.toArray<HTMLElement>("[data-line]", pane);
          if (i > 0) {
            tl.to(tabs[i - 1], { ...IDLE, duration: 0.2 }).to(tabs[i], { ...ACTIVE, duration: 0.2 }, "<");
            tl.to(panes[i - 1], { opacity: 0.45, duration: 0.3 }, "<");
          }
          lines.forEach((el, j) => {
            tl.fromTo(el, { autoAlpha: 0, x: -10 }, { autoAlpha: 1, x: 0, duration: 0.45, ease: "power2.out" }, j === 0 ? ">" : ">-0.1");
            const line = PANES[i].lines[j];
            if (line.kind === "call" && credits) {
              tl.to(counter, {
                value: line.creditsAfter,
                duration: 0.3,
                snap: "value",
                onUpdate: () => {
                  credits.textContent = String(Math.round(counter.value));
                },
              });
            }
          });
          tl.to({}, { duration: 0.4 });
        });
      }

      gsap.set(tabs.slice(1), IDLE);
      gsap.set(tabs[0], ACTIVE);
      gsap.set(gsap.utils.toArray<HTMLElement>("[data-line]", root), { autoAlpha: 0, x: -10 });

      const mm = gsap.matchMedia();
      mm.add(
        { desktop: "(min-width: 1024px)", small: "(max-width: 1023px)" },
        (ctx) => {
          const { desktop } = ctx.conditions as { desktop: boolean };
          const tl = gsap.timeline({
            scrollTrigger: desktop
              ? { trigger: root, start: "center center", end: "+=1400", pin: true, scrub: 0.8, anticipatePin: 1, invalidateOnRefresh: true }
              : { trigger: root, start: "top 80%", toggleActions: "play none none none" },
          });
          build(tl);
          return () => {
            tl.kill();
          };
        },
      );
    },
    { scope: wrap },
  );

  return (
    <div ref={wrap} className="relative py-6 lg:py-10">
      <Floaters className="pointer-events-none absolute inset-0" aria-hidden>
        <CloudDoodle data-float className="absolute -left-6 -top-2 h-16 sm:-left-16 sm:top-6 sm:h-24" />
        <SmallCloudDoodle data-float className="absolute -right-4 top-0 h-9 sm:-right-10 sm:top-16 sm:h-12" />
        <TriangleDoodle data-float className="absolute -bottom-2 left-8 h-8 sm:-bottom-4 sm:left-24 sm:h-12" />
        <CoinDoodle data-float className="absolute -bottom-4 right-6 h-10 sm:-right-12 sm:bottom-10 sm:h-14" />
        <SmallCloudDoodle data-float className="absolute bottom-10 -left-2 hidden h-8 sm:block" />
      </Floaters>

      <div className="relative mx-auto max-w-[1040px] rounded-[2px] border-2 border-ink bg-frost shadow-hard-lg">
        <ol className="flex overflow-x-auto border-b-2 border-ink text-caption font-semibold uppercase tracking-[0.04em]">
          {PANES.map((p) => (
            <li
              key={p.tab}
              data-tab
              className="shrink-0 border-r-2 border-ink bg-frost px-4 py-2.5 text-ink data-[active=true]:bg-ink data-[active=true]:text-cream"
            >
              {p.tab}
            </li>
          ))}
        </ol>

        <div className="grid gap-6 bg-ink p-4 text-body text-cream sm:p-6 lg:grid-cols-3 lg:gap-8">
          {PANES.map((p) => (
            <div key={p.tab} data-pane className="min-w-0">
              <p className="mb-3 border-b border-graphite pb-2 text-caption uppercase tracking-[0.06em] text-pencil">{p.title}</p>
              <ol className="space-y-2">
                {p.lines.map((line, i) => (
                  <LineRow key={i} line={line} />
                ))}
              </ol>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t-2 border-ink bg-frost px-4 py-2.5 text-caption font-semibold uppercase tracking-[0.04em]">
          <span className="flex items-center gap-2">
            <span aria-hidden className="inline-block size-2.5 border border-ink bg-mint" />
            connected · cardano preprod
          </span>
          <span className="flex items-center gap-2">
            credits
            <span className="rounded-[2px] border border-ink bg-canary px-2 py-0.5 tabular-nums">
              <span data-credits>{PACK}</span>
              {` / ${PACK}`}
            </span>
            spent only on pass
          </span>
        </div>
      </div>
    </div>
  );
}
