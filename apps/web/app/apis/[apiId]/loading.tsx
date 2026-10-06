import { Skeleton } from "@/components/ui/skeleton";

/** Mirrors the API pages: a nav row, a heading, then a few bordered blocks. */
export default function Loading() {
  return (
    <div role="status" aria-live="polite" aria-label="Loading this API" className="space-y-6">
      <div className="flex gap-6 border-b border-ink pb-3">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-4 w-12" />
      </div>
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-6 w-20" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="rounded-[2px] border-2 border-silver bg-frost p-4">
            <Skeleton className="mb-3 h-3 w-2/3" />
            <Skeleton className="h-7 w-1/2" />
          </div>
        ))}
      </div>
      <div className="rounded-[2px] border-2 border-silver bg-frost p-6">
        <Skeleton className="mb-3 h-4 w-1/3" />
        <Skeleton className="mb-2 h-3 w-full" />
        <Skeleton className="h-3 w-5/6" />
      </div>
      <span className="sr-only">Loading this API</span>
    </div>
  );
}
