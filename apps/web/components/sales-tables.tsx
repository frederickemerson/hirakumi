import { EmptyState } from "@/components/states";
import { cardanoscanTxUrl, formatTime, JOB_STATUS_LABEL, PACK_STATUS_LABEL, shortAddress } from "@/lib/copy";
import { formatTusdm } from "@/lib/money";
import type { EscrowJob, PackSale } from "@/lib/repo/stats";

const th = "px-3 py-2 text-left text-caption font-semibold uppercase tracking-[0.04em]";
const td = "px-3 py-3 align-top";

export function PackSalesTable({ sales }: { sales: PackSale[] }) {
  if (sales.length === 0) {
    return <EmptyState title="No pack sales yet" detail="When an agent buys a pack, it shows up here with a link to the payment on Cardanoscan." />;
  }
  return (
    <div className="overflow-x-auto rounded-[2px] border-2 border-ink bg-frost">
      <table className="w-full min-w-[640px] text-body">
        <thead className="bg-chalk">
          <tr className="border-b-2 border-ink">
            <th className={th}>Date</th><th className={th}>Buyer</th><th className={th}>Credits</th><th className={th}>Price</th><th className={th}>Status</th><th className={th}>Payment</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink">
          {sales.map((s) => (
            <tr key={s.id}>
              <td className={`${td} whitespace-nowrap`}>{formatTime(s.createdAt)}</td>
              <td className={td}>{s.payer ? shortAddress(s.payer) : "Unknown"}</td>
              <td className={`${td} tabular-nums`}>{`${s.remaining} of ${s.calls} left`}</td>
              <td className={`${td} tabular-nums`}>{`${formatTusdm(s.priceMicros)} tUSDM`}</td>
              <td className={td}>{PACK_STATUS_LABEL[s.status]}</td>
              <td className={td}>
                {s.txHash ? (
                  <a href={cardanoscanTxUrl(s.txHash)} target="_blank" rel="noreferrer" className="underline underline-offset-4">View on Cardanoscan</a>
                ) : (
                  "Not recorded yet"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function reasonsOf(job: EscrowJob): string[] {
  return Array.isArray(job.failureReasons) ? job.failureReasons.filter((r): r is string => typeof r === "string") : [];
}

export function EscrowJobsTable({ jobs }: { jobs: EscrowJob[] }) {
  if (jobs.length === 0) {
    return <EmptyState title="No per-job hires yet" detail="When someone hires your API through Masumi escrow, the job shows up here." />;
  }
  return (
    <div className="overflow-x-auto rounded-[2px] border-2 border-ink bg-frost">
      <table className="w-full min-w-[560px] text-body">
        <thead className="bg-chalk">
          <tr className="border-b-2 border-ink">
            <th className={th}>Date</th><th className={th}>Buyer reference</th><th className={th}>Status</th><th className={th}>What failed</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink">
          {jobs.map((j) => (
            <tr key={j.id}>
              <td className={`${td} whitespace-nowrap`}>{formatTime(j.createdAt)}</td>
              <td className={`${td} break-all`}>{j.identifierFromPurchaser}</td>
              <td className={td}>{JOB_STATUS_LABEL[j.status]}</td>
              <td className={td}>
                <ul>{reasonsOf(j).map((r) => <li key={r}>{r}</li>)}</ul>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
