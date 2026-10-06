"use client";

import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { useRef, type ReactNode } from "react";
import { motionAllowed } from "@/lib/motion";

gsap.registerPlugin(useGSAP);

/** Gives every child marked data-float a slow, offset sine drift, like paper doodles in a breeze. */
export function Floaters({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      if (!ref.current || !motionAllowed()) return;
      gsap.utils.toArray<HTMLElement>("[data-float]", ref.current).forEach((el, i) => {
        const dir = i % 2 === 0 ? 1 : -1;
        gsap.to(el, {
          y: `+=${8 + (i % 3) * 4}`,
          x: `+=${dir * 5}`,
          rotation: dir * 2,
          duration: 3.2 + (i % 4) * 0.6,
          ease: "sine.inOut",
          yoyo: true,
          repeat: -1,
          delay: -i * 0.7,
        });
      });
    },
    { scope: ref },
  );
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
