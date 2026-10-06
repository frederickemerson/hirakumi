import { formatHealthReasons } from "@hirakumi/core";
import type { Incident } from "@/lib/repo/stats";
import { hhmm, HourBars } from "@/components/hour-bars";
import type { PublicStatus } from "@/lib/repo/status";

const pct = (n: number | null) => (n === null ? "No data yet" : `${n}%`);

/** Public, honest health: what the monitor saw, not what the seller says. */
export function StatusPanel({ status, incidents }: { status: PublicStatus; incidents: Incident[] }) {
  return (
    <section aria-labelledby="status-heading" className="space-y-5 rounded-[2px] border-2 border-ink bg-frost p-5 sm:p-6">
      <h2 id="status-heading" className="text-sub font-semibold uppercase">Status (last 24 hours)</h2>
      <dl className="grid gap-4 text-body sm:grid-cols-3">
        <div>
          <dt className="text-caption uppercase tracking-[0.04em] text-graphite">Promise kept on test calls</dt>
          <dd className="text-h-sm font-medium tabular-nums">{pct(status.uptimePct)}</dd>
        </div>
        <div>
          <dt className="text-caption uppercase tracking-[0.04em] text-graphite">Paid calls that kept the promise</dt>
          <dd className="text-h-sm font-medium tabular-nums">{pct(status.passRatePct)}</dd>
          <dd className="text-caption text-graphite tabular-nums">{status.paidCalls} paid calls</dd>
        </div>
        <div>
          <dt className="text-caption uppercase tracking-[0.04em] text-graphite">Typical response time</dt>
          <dd className="text-h-sm font-medium tabular-nums">{status.p50LatencyMs === null ? "No data yet" : `${status.p50LatencyMs} ms`}</dd>
        </div>
      </dl>
      <HourBars hours={status.hours} />
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-graphite" aria-hidden>
        <li className="flex items-center gap-1.5"><span className="inline-block size-2.5 border border-ink bg-sky" />Live</li>
        <li className="flex items-center gap-1.5"><span className="inline-block size-2.5 border border-ink bg-canary" />Some checks failed</li>
        <li className="flex items-center gap-1.5"><span className="inline-block size-2.5 border border-ink bg-coral" />Down</li>
        <li className="flex items-center gap-1.5"><span className="inline-block size-2.5 border border-ink bg-chalk" />No checks</li>
      </ul>
      <p className="text-caption text-graphite">
        Hirakumi calls this API with saved test inputs and checks every answer against its promise. Buyers are never charged
        while it is Down.
      </p>
      <div className="space-y-2 border-t border-ink pt-4">
        <h3 className="text-body font-semibold uppercase tracking-[0.04em]">Recent incidents</h3>
        {incidents.length === 0 ? (
          <p className="text-body text-graphite">No incidents in the last checks.</p>
        ) : (
          <ul className="space-y-2 text-body">
            {incidents.map((i) => (
              <li key={i.downAt.toISOString()} className="rounded-[2px] border-2 border-ink border-l-8 border-l-coral p-3">
                <p>
                  Down at {hhmm(i.downAt)}{i.upAt ? `, Live again at ${hhmm(i.upAt)}` : ", still Down"}. {i.creditsUsed} credits used,{" "}
                  {i.callsNotPassed} calls refused without charge.
                </p>
                <ul className="list-disc pl-5 text-graphite">
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
