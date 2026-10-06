import { Skeleton } from "@/components/ui/skeleton";

/** Mirrors /account block for block (title, totals, account card, API rows) so nothing jumps when it lands. */
export default function Loading() {
  return (
    <div role="status" aria-live="polite" aria-label="Loading your account" className="space-y-8">
      <div className="space-y-2">
        <Skeleton className="h-8 w-2/3 max-w-sm" />
        <Skeleton className="h-4 w-full max-w-md" />
      </div>
      <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="rounded-[2px] border-2 border-silver bg-frost p-4">
            <Skeleton className="mb-2 h-3 w-20" />
            <Skeleton className="h-7 w-16" />
          </div>
        ))}
      </div>
      <div className="space-y-3">
        <Skeleton className="h-6 w-28" />
        <div className="space-y-3 rounded-[2px] border-2 border-silver bg-frost p-4">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      </div>
      <div className="space-y-4">
        <Skeleton className="h-6 w-32" />
        <div className="rounded-[2px] border-2 border-silver bg-frost">
          {Array.from({ length: 2 }, (_, i) => (
            <div key={i} className="space-y-4 border-silver p-4 [&:not(:first-child)]:border-t-2">
              <div className="flex justify-between gap-4">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-6 w-16" />
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {Array.from({ length: 4 }, (_, j) => <Skeleton key={j} className="h-9" />)}
              </div>
              <div className="flex gap-2">
                <Skeleton className="h-8 w-16" />
                <Skeleton className="h-8 w-20" />
              </div>
            </div>
          ))}
        </div>
      </div>
      <span className="sr-only">Loading your account</span>
    </div>
  );
}
