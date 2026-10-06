"use client";

import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { createElement, useRef, type CSSProperties, type ReactNode } from "react";
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
 * Settles its children into place once as they scroll into view.
 *
 * The hidden starting state is plain CSS (globals.css, `html.js [data-reveal-root]`), gated by the
 * `js` class that app/layout.tsx sets before first paint. So the server HTML never flashes visible
 * and then vanishes on hydration, and without JavaScript or with reduced motion everything is shown.
 * Mark children with data-reveal to stagger them; otherwise the wrapper itself moves.
 * Only transform and opacity change, with a plain ease-out (no overshoot).
 */
export function Reveal({ children, className, as = "div", id, y = 18, stagger = 0.07 }: Props) {
  const ref = useRef<HTMLElement | null>(null);
  useGSAP(
    () => {
      const el = ref.current;
      if (!el || !motionAllowed()) return;
      const ScrollTrigger = withScrollTrigger();
      const marked = Array.from(el.querySelectorAll<HTMLElement>("[data-reveal]"));
      const targets = marked.length > 0 ? marked : [el];
      const reveal = () => {
        // Hand the hidden state from CSS to inline styles, then release the CSS gate and animate.
        gsap.set(targets, { opacity: 0, y });
        el.setAttribute("data-revealed", "");
        gsap.to(targets, {
          opacity: 1,
          y: 0,
          duration: 0.55,
          ease: "power3.out",
          stagger,
          overwrite: "auto",
          clearProps: "opacity,transform",
        });
      };
      ScrollTrigger.create({ trigger: el, start: "top 95%", once: true, onEnter: reveal });
    },
    { scope: ref },
  );
  return createElement(
    as,
    { ref, className, id, "data-reveal-root": "", style: { "--reveal-y": `${y}px` } as CSSProperties },
    children,
  );
}
