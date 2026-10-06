"use client";

import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { createElement, useRef, type ReactNode } from "react";
import { motionAllowed, withScrollTrigger } from "@/lib/motion";

gsap.registerPlugin(useGSAP);

type Props = {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "ul" | "ol" | "header" | "article" | "dl";
  id?: string;
  /** Vertical travel in px. */
  y?: number;
  /** Delay between children marked data-reveal. */
  stagger?: number;
};

/**
 * Snaps its children into place once as they scroll into view: opacity settles fast, the vertical
 * travel lands with a small overshoot, so the element reads as "clicking in" rather than drifting.
 * Mark children with data-reveal to stagger them; otherwise the wrapper itself moves.
 * Only transform and opacity change, so nothing shifts layout.
 */
export function Reveal({ children, className, as = "div", id, y = 18, stagger = 0.07 }: Props) {
  const ref = useRef<HTMLElement | null>(null);
  useGSAP(
    () => {
      const el = ref.current;
      if (!el || !motionAllowed()) return;
      withScrollTrigger();
      const marked = Array.from(el.querySelectorAll<HTMLElement>("[data-reveal]"));
      const targets = marked.length > 0 ? marked : [el];
      gsap.set(targets, { autoAlpha: 0, y });
      const tl = gsap.timeline({ scrollTrigger: { trigger: el, start: "top 86%", once: true } });
      tl.to(targets, { autoAlpha: 1, duration: 0.3, ease: "power2.out", stagger, overwrite: "auto" }, 0);
      tl.to(targets, { y: 0, duration: 0.5, ease: "back.out(1.4)", stagger, overwrite: "auto" }, 0);
    },
    { scope: ref },
  );
  return createElement(as, { ref, className, id }, children);
}
