import { SparkleDoodle } from "@/components/brand/doodles";

const ITEMS = [
  "Pay only for kept promises",
  "Stale data costs nothing",
  "Money goes straight to your wallet",
  "Cardano preprod",
  "Masumi registry",
  "x402 call packs",
  "Escrow jobs, automatic refunds",
  "Status that tells the truth",
];

/** Full-bleed canary strip, mono 600 uppercase, scrolling left. Pauses on hover; still under reduced motion. */
export function Marquee() {
  const row = (hidden: boolean) => (
    <ul aria-hidden={hidden || undefined} className="flex shrink-0 items-center">
      {ITEMS.map((t) => (
        <li key={t} className="flex items-center gap-8 whitespace-nowrap pr-8">
          <span>{t}</span>
          <SparkleDoodle className="h-5" />
        </li>
      ))}
    </ul>
  );
  return (
    <section aria-label="What Hirakumi promises" className="bleed overflow-hidden bg-canary py-5 text-sub font-semibold uppercase tracking-[0.04em] text-ink sm:text-[20px]">
      <div className="flex w-max animate-marquee hover:[animation-play-state:paused]" style={{ "--marquee-duration": "48s" } as React.CSSProperties}>
        {row(false)}
        {row(true)}
      </div>
    </section>
  );
}
