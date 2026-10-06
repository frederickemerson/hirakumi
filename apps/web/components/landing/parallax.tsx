"use client";

import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { useRef, type ReactNode } from "react";
import { motionAllowed, withScrollTrigger } from "@/lib/motion";

gsap.registerPlugin(useGSAP);

/**
 * Drifts its child up by `distance` px while the enclosing section scrolls out of view, so it trails
 * the page a little. Transform only, scrubbed to the scroll position; still with reduced motion.
 */
export function Parallax({ children, distance = 40, className }: { children: ReactNode; distance?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useGSAP(() => {
    const el = ref.current;
    const section = el?.closest("section") ?? el;
    if (!el || !section || !motionAllowed()) return;
    withScrollTrigger();
    gsap.to(el, {
      y: -distance,
      ease: "none",
      scrollTrigger: { trigger: section, start: "top top", end: "bottom top", scrub: 0.3 },
    });
  });
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
