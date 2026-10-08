import { plural } from "@/lib/copy";
import { formatTusdm } from "@/lib/money";
import type { OverviewStats } from "@/lib/repo/stats";

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-[2px] border-2 border-ink bg-frost p-4">
      <p className="text-caption uppercase tracking-[0.04em] text-graphite">{label}</p>
      <p className="mt-1 text-h-sm font-medium tabular-nums">{value}</p>
      {note && <p className="mt-1 text-caption text-graphite">{note}</p>}
    </div>
  );
}

/** The four numbers a seller watches. Amounts are test USDM on preprod, so they are "received", never "earned". */
export function OverviewStatGrid({ stats }: { stats: OverviewStats }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Stat label="Paid calls, last 24 hours" value={String(stats.callsDay)} />
      <Stat label="Kept the promise" value={stats.passRate === null ? "No paid calls yet" : `${Math.round(stats.passRate * 100)}%`}
        note={`${stats.passDay} passed, ${stats.failDay} didn't (no credit used)`} />
      <Stat label="Received from packs" value={`${formatTusdm(stats.packEarningsMicros)} tUSDM`} note={`${plural(stats.packSales, "pack")} sold`} />
      <Stat label="Received from single jobs" value={`${formatTusdm(stats.escrowNetMicros)} tUSDM`}
        note={stats.escrowJobs === 0
          ? "No jobs yet"
          : `${plural(stats.escrowJobs, "job")}: buyers paid ${formatTusdm(stats.escrowGrossMicros)} tUSDM, Masumi kept ${formatTusdm(stats.escrowFeeMicros)} tUSDM`} />
    </div>
  );
}
