import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

/** True in a real browser that has not asked for reduced motion. False on the server and in jsdom. */
export function motionAllowed(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

let scrollTriggerReady = false;

/**
 * Registers ScrollTrigger on first use. Registration touches window.matchMedia, so it must not
 * happen at module load (jsdom has no matchMedia) and is pointless when motion is off.
 */
export function withScrollTrigger(): typeof ScrollTrigger {
  if (!scrollTriggerReady) {
    gsap.registerPlugin(ScrollTrigger);
    scrollTriggerReady = true;
  }
  return ScrollTrigger;
}
