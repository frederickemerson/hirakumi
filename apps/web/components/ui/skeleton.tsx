import { cn } from "cn"

/** Chalk block with a cream sheen passing over it. Shape it like the content it stands in for. */
export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      aria-hidden
      className={cn("relative overflow-hidden rounded-[2px] bg-chalk", className)}
      {...props}
    >
      <span className="absolute inset-0 -translate-x-full bg-[linear-gradient(90deg,transparent,rgba(244,239,234,0.9),transparent)] motion-safe:[animation:shimmer_1.4s_ease-in-out_infinite]" />
    </div>
  )
}

/** A page-shaped skeleton: heading, a paragraph and a few card rows. */
export function PageSkeleton({ rows = 3, label = "Loading" }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-live="polite" aria-label={label} className="space-y-6">
      <div className="space-y-3">
        <Skeleton className="h-8 w-2/3 max-w-md" />
        <Skeleton className="h-4 w-full max-w-xl" />
        <Skeleton className="h-4 w-3/4 max-w-lg" />
      </div>
      <div className="space-y-3">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="rounded-[2px] border-2 border-silver bg-frost p-4">
            <Skeleton className="mb-2 h-4 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ))}
      </div>
      <span className="sr-only">{label}</span>
    </div>
  )
}
