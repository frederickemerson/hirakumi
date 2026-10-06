import { formatHealthReasons } from "@hirakumi/core";
import type { Incident } from "@/lib/repo/stats";
import type { HourState, PublicStatus } from "@/lib/repo/status";

const STATE_LABEL: Record<HourState, string> = { up: "Live", degraded: "Some checks failed", down: "Down", no_data: "No checks" };
const STATE_CLASS: Record<HourState, string> = {
  up: "bg-emerald-500",
  degraded: "bg-amber-400",
  down: "bg-red-500",
  no_data: "bg-muted",
};

const hhmm = (d: Date) => `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
const pct = (n: number | null) => (n === null ? "No data yet" : `${n}%`);

/** Public, honest health: what the monitor saw, not what the seller says. */
export function StatusPanel({ status, incidents }: { status: PublicStatus; incidents: Incident[] }) {
  return (
    <section aria-labelledby="status-heading" className="space-y-4 rounded-lg border p-4">
      <h2 id="status-heading" className="text-lg font-semibold">Status (last 24 hours)</h2>
      <dl className="grid grid-cols-3 gap-4 text-sm">
        <div>
          <dt className="text-muted-foreground">Promise kept on test calls</dt>
          <dd className="text-xl font-semibold tabular-nums">{pct(status.uptimePct)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Paid calls that kept the promise</dt>
          <dd className="text-xl font-semibold tabular-nums">{pct(status.passRatePct)}</dd>
          <dd className="text-muted-foreground tabular-nums">{status.paidCalls} paid calls</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Typical response time</dt>
          <dd className="text-xl font-semibold tabular-nums">{status.p50LatencyMs === null ? "No data yet" : `${status.p50LatencyMs} ms`}</dd>
        </div>
      </dl>
      <ol className="flex h-8 items-end gap-0.5" aria-label="Hourly health, oldest first">
        {status.hours.map((h) => {
          const label = `${hhmm(h.start)}: ${STATE_LABEL[h.state]}${h.probes ? ` (${h.passed} of ${h.probes} checks passed)` : ""}`;
          return <li key={h.start.toISOString()} aria-label={label} title={label} className={`h-full flex-1 rounded-sm ${STATE_CLASS[h.state]}`} />;
        })}
      </ol>
      <p className="text-xs text-muted-foreground">
        Hirakumi calls this API with saved test inputs and checks every answer against its promise. Buyers are never charged
        while it is Down.
      </p>
      <div className="space-y-2">
        <h3 className="font-medium">Recent incidents</h3>
        {incidents.length === 0 ? (
          <p className="text-sm text-muted-foreground">No incidents in the last checks.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {incidents.map((i) => (
              <li key={i.downAt.toISOString()} className="rounded border p-2">
                <p>
                  Down at {hhmm(i.downAt)}{i.upAt ? `, Live again at ${hhmm(i.upAt)}` : ", still Down"}. {i.creditsUsed} credits used,{" "}
                  {i.callsNotPassed} calls refused without charge.
                </p>
                <ul className="list-disc pl-5 text-muted-foreground">
                  {formatHealthReasons(i.reasons).map((r) => <li key={r}>{r}</li>)}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
