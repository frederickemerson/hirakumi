"use client";

import { gsap } from "gsap";
import Lenis from "lenis";
import { useEffect } from "react";
import { motionAllowed, withScrollTrigger } from "@/lib/motion";

/** Lenis smooth scrolling driven by the GSAP ticker so ScrollTrigger and the scroll position agree. */
export function SmoothScroll() {
  useEffect(() => {
    if (!motionAllowed()) return;
    const ScrollTrigger = withScrollTrigger();
    const lenis = new Lenis({ autoRaf: false, lerp: 0.1, anchors: true });
    const update = () => ScrollTrigger.update();
    lenis.on("scroll", update);
    const raf = (time: number) => lenis.raf(time * 1000);
    gsap.ticker.add(raf);
    gsap.ticker.lagSmoothing(0);
    return () => {
      gsap.ticker.remove(raf);
      gsap.ticker.lagSmoothing(500, 33);
      lenis.off("scroll", update);
      lenis.destroy();
    };
  }, []);
  return null;
}
