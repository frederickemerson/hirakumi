"use client";

import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { useRef } from "react";
import { motionAllowed, withScrollTrigger } from "@/lib/motion";

gsap.registerPlugin(useGSAP);

/**
 * A number that runs from `from` to `value` as it scrolls up into view, tied to the scroll position
 * (scrubbed, so scrolling back runs it back). The server HTML and reduced motion show the final value.
 * Tabular numerals and a fixed number of decimals keep the width still while it counts.
 * Screen readers get the final value only.
 */
export function CountUp({ value, from = 0, decimals = 0, className }: { value: number; from?: number; decimals?: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const final = value.toFixed(decimals);

  useGSAP(() => {
    const el = ref.current;
    if (!el || !motionAllowed()) return;
    withScrollTrigger();
    const n = { v: from };
    const write = () => {
      el.textContent = n.v.toFixed(decimals);
    };
    gsap.to(n, {
      v: value,
      ease: "power2.out",
      onUpdate: write,
      scrollTrigger: { trigger: el, start: "top 92%", end: "top 55%", scrub: 0.4, onRefresh: write },
    });
    write();
  });

  return (
    <span className={className}>
      <span ref={ref} aria-hidden className="tabular-nums">{final}</span>
      <span className="sr-only">{final}</span>
    </span>
  );
}
