"use client";

import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { useRef } from "react";
import { motionAllowed, withScrollTrigger } from "@/lib/motion";
import { cn } from "@/lib/utils";

gsap.registerPlugin(useGSAP);

export type Paragraph = { text: string; strong?: boolean };

/**
 * An argument that reads at scroll speed: the words brighten one after another as the block
 * passes through the viewport, so the reader is paced through the problem to the insight.
 * Static (fully shown) with reduced motion. Layout never changes; only opacity does.
 */
export function ScrubText({ paragraphs, className }: { paragraphs: Paragraph[]; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      const el = ref.current;
      if (!el || !motionAllowed()) return;
      withScrollTrigger();
      const words = gsap.utils.toArray<HTMLElement>("[data-word]", el);
      gsap.fromTo(
        words,
        { opacity: 0.22 },
        {
          opacity: 1,
          ease: "none",
          stagger: 0.6,
          scrollTrigger: { trigger: el, start: "top 78%", end: "bottom 58%", scrub: 0.35 },
        },
      );
    },
    { scope: ref },
  );
  return (
    <div ref={ref} className={cn("space-y-6", className)}>
      {paragraphs.map((p) => (
        <p key={p.text} className={cn(p.strong && "font-medium")}>
          {p.text.split(" ").map((w, i) => (
            <span key={i} data-word className="inline-block">
              {w}
              {" "}
            </span>
          ))}
        </p>
      ))}
    </div>
  );
}
