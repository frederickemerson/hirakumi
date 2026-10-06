"use client";

import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { useRef } from "react";
import { motionAllowed, withScrollTrigger } from "@/lib/motion";

gsap.registerPlugin(useGSAP);

/**
 * The thread through the "How it works" step numbers: a dotted track from the first badge to the last,
 * and an ink line that fills along it as the steps scroll through the viewport (scrubbed).
 * Horizontal when the steps sit in a row, vertical when they stack. Place it inside the same
 * positioned wrapper as the badges (marked data-step-badge), before them so they paint on top.
 * Without motion the line is simply drawn in full.
 */
export function StepLine() {
  const ref = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLSpanElement>(null);

  useGSAP(() => {
    const line = ref.current;
    const bar = fill.current;
    const root = line?.parentElement;
    if (!line || !bar || !root) return;

    const place = () => {
      const badges = Array.from(root.querySelectorAll<HTMLElement>("[data-step-badge]"));
      if (badges.length < 2) return;
      // Layout offsets, not bounding boxes: the steps may be mid-reveal (translated) when this runs.
      const centre = (el: HTMLElement) => {
        let x = el.offsetWidth / 2;
        let y = el.offsetHeight / 2;
        for (let n: HTMLElement | null = el; n && n !== root; n = n.offsetParent as HTMLElement | null) {
          x += n.offsetLeft;
          y += n.offsetTop;
        }
        return { x, y };
      };
      const { x: ax, y: ay } = centre(badges[0]);
      const { x: bx, y: by } = centre(badges[badges.length - 1]);
      const across = Math.abs(by - ay) < 2;
      line.dataset.axis = across ? "x" : "y";
      Object.assign(line.style, across
        ? { left: `${ax}px`, top: `${ay - 1}px`, width: `${bx - ax}px`, height: "2px" }
        : { left: `${ax - 1}px`, top: `${ay}px`, width: "2px", height: `${by - ay}px` });
      bar.style.transformOrigin = across ? "left center" : "center top";
    };
    place();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    ro?.observe(root);

    if (motionAllowed()) {
      withScrollTrigger();
      // Scale along the axis the line runs on; the other axis stays at 1.
      gsap.fromTo(
        bar,
        { scaleX: () => (line.dataset.axis === "x" ? 0 : 1), scaleY: () => (line.dataset.axis === "y" ? 0 : 1) },
        {
          scaleX: 1,
          scaleY: 1,
          ease: "none",
          scrollTrigger: { trigger: root, start: "top 75%", end: "bottom 60%", scrub: 0.5, invalidateOnRefresh: true },
        },
      );
    }
    return () => ro?.disconnect();
  });

  return (
    <div ref={ref} aria-hidden className="pointer-events-none absolute">
      <span className="absolute inset-0 [background-image:repeating-linear-gradient(var(--line-dir,90deg),var(--color-silver)_0_6px,transparent_6px_10px)] in-data-[axis=y]:[--line-dir:180deg]" />
      <span ref={fill} className="absolute inset-0 bg-ink" />
    </div>
  );
}
