import { cn } from "cn"

/**
 * A small ink square that turns in eight steps: the house loading glyph.
 * Give it a `label` when it stands alone; leave it out when the surrounding control already says it is busy.
 */
export function Spinner({ className, label }: { className?: string; label?: string }) {
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true as const }
  return (
    <span
      {...a11y}
      className={cn("inline-block size-3 shrink-0 border-2 border-ink border-r-sky animate-spin-square", className)}
    />
  )
}
