import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shaped like an onboarding step page: a heading, then the step card with the listing timeline
 * (progress bar and seven rows). The tab strip stays real, since it lives in the layout.
 */
export default function Loading() {
  return (
    <div role="status" aria-live="polite" aria-label="Loading this step" className="space-y-6">
      <Skeleton className="h-8 w-64 max-w-full" />
      <div className="space-y-4 rounded-[2px] border-2 border-silver bg-frost p-6">
        <div className="flex items-center gap-3">
          <Skeleton className="size-3.5" />
          <Skeleton className="h-4 w-56 max-w-[60%]" />
          <Skeleton className="ml-auto h-3 w-10" />
        </div>
        <Skeleton className="h-3 w-full max-w-lg" />
        <div className="flex items-center justify-between">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-3 w-8" />
        </div>
        <div className="flex h-4 overflow-hidden rounded-[2px] border-2 border-silver">
          {Array.from({ length: 7 }, (_, i) => (
            <span key={i} className="flex-1 border-r border-silver last:border-r-0" />
          ))}
        </div>
        <ul className="space-y-2.5">
          {[44, 52, 48, 40, 32, 46, 50].map((w, i) => (
            <li key={i} className="flex items-center justify-between gap-4">
              <Skeleton className="h-3.5" style={{ width: `${w}%` }} />
              <Skeleton className="h-3.5 w-16" />
            </li>
          ))}
        </ul>
      </div>
      <span className="sr-only">Loading this step</span>
    </div>
  );
}
