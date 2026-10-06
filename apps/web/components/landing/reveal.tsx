"use client";

import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { createElement, useRef, type ReactNode } from "react";
import { motionAllowed, withScrollTrigger } from "@/lib/motion";

gsap.registerPlugin(useGSAP);

type Props = {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "ul" | "ol" | "header" | "article";
  id?: string;
  /** Vertical travel in px. */
  y?: number;
  /** Delay between children marked data-reveal. */
  stagger?: number;
};

/**
 * Reveals its children once as they scroll into view: a short rise with a long settle.
 * Mark children with data-reveal to stagger them; otherwise the wrapper itself moves.
 * Only transform and opacity change, so nothing shifts layout.
 */
export function Reveal({ children, className, as = "div", id, y = 24, stagger = 0.08 }: Props) {
  const ref = useRef<HTMLElement | null>(null);
  useGSAP(
    () => {
      const el = ref.current;
      if (!el || !motionAllowed()) return;
      withScrollTrigger();
      const marked = Array.from(el.querySelectorAll<HTMLElement>("[data-reveal]"));
      const targets = marked.length > 0 ? marked : [el];
      gsap.fromTo(
        targets,
        { autoAlpha: 0, y },
        {
          autoAlpha: 1,
          y: 0,
          duration: 0.8,
          ease: "power3.out",
          stagger,
          overwrite: "auto",
          scrollTrigger: { trigger: el, start: "top 88%", once: true },
        },
      );
    },
    { scope: ref },
  );
  return createElement(as, { ref, className, id }, children);
}
