import { cn } from "@/lib/utils";

type HourState = "up" | "degraded" | "down" | "no_data";

const CLASS: Record<HourState, string> = {
  up: "bg-sky",
  degraded: "bg-canary",
  down: "bg-coral",
  no_data: "bg-chalk",
};

/** An illustrative 24-hour strip in the same shape as the public status page's. */
export function StatusStrip({ hours, className }: { hours: HourState[]; className?: string }) {
  return (
    <ol aria-label="Example of the 24-hour uptime strip" className={cn("flex h-10 items-stretch gap-0.5", className)}>
      {hours.map((h, i) => (
        <li key={i} aria-label={h === "up" ? "Live" : h === "down" ? "Down" : h === "degraded" ? "Some checks failed" : "No checks"} className={cn("flex-1 rounded-[2px] border border-ink", CLASS[h])} />
      ))}
    </ol>
  );
}
