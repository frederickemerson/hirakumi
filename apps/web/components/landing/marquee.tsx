import { SparkleDoodle } from "@/components/brand/doodles";

const ITEMS = [
  "Paid only for kept promises",
  "Stale answer, no charge",
  "Packs paid in USDM on Cardano",
  "Listed on Masumi and Sokosumi",
  "Settled in 9.4 to 16.5 s",
  "A receipt for every call",
  "Public status page",
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
    <section aria-label="What Hirakumi does" className="bleed overflow-hidden bg-canary py-4 text-sub font-semibold uppercase tracking-[0.04em] text-ink sm:text-[20px]">
      <div className="flex w-max animate-marquee hover:[animation-play-state:paused]" style={{ "--marquee-duration": "44s" } as React.CSSProperties}>
        {row(false)}
        {row(true)}
      </div>
    </section>
  );
}
