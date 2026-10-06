import { Skeleton } from "@/components/ui/skeleton";

/** Mirrors the public status page: title and badge, the status card with its 24 bars, then promises. */
export default function Loading() {
  return (
    <div role="status" aria-live="polite" aria-label="Loading the status page" className="space-y-6">
      <div className="flex items-center gap-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-6 w-16" />
      </div>
      <div className="rounded-[2px] border-2 border-silver bg-frost p-6">
        <Skeleton className="mb-5 h-5 w-48" />
        <div className="mb-5 grid grid-cols-3 gap-4">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
        <div className="flex h-8 gap-0.5">
          {Array.from({ length: 24 }, (_, i) => (
            <Skeleton key={i} className="h-full flex-1" />
          ))}
        </div>
      </div>
      <div className="rounded-[2px] border-2 border-silver bg-frost p-4">
        <Skeleton className="mb-2 h-4 w-32" />
        <Skeleton className="h-3 w-3/4" />
      </div>
      <span className="sr-only">Loading the status page</span>
    </div>
  );
}
