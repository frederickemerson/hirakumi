import { EmptyState } from "@/components/states";
import { cardanoscanTxUrl, formatTime, JOB_STATUS_LABEL, PACK_STATUS_LABEL, shortAddress } from "@/lib/copy";
import { formatTusdm } from "@/lib/money";
import type { EscrowJob, PackSale } from "@/lib/repo/stats";

export function PackSalesTable({ sales }: { sales: PackSale[] }) {
  if (sales.length === 0) {
    return <EmptyState title="No pack sales yet" detail="When an agent buys a pack, it shows up here with a link to the payment on Cardanoscan." />;
  }
  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b">
          <th className="py-2">Date</th><th>Buyer</th><th>Credits</th><th>Price</th><th>Status</th><th>Payment</th>
        </tr>
      </thead>
      <tbody>
        {sales.map((s) => (
          <tr key={s.id} className="border-b">
            <td className="py-2">{formatTime(s.createdAt)}</td>
            <td>{s.payer ? shortAddress(s.payer) : "Unknown"}</td>
            <td>{`${s.remaining} of ${s.calls} left`}</td>
            <td>{`${formatTusdm(s.priceMicros)} tUSDM`}</td>
            <td>{PACK_STATUS_LABEL[s.status]}</td>
            <td>
              {s.txHash ? (
                <a href={cardanoscanTxUrl(s.txHash)} target="_blank" rel="noreferrer" className="underline">View on Cardanoscan</a>
              ) : (
                "Not recorded yet"
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
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
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b">
          <th className="py-2">Date</th><th>Buyer reference</th><th>Status</th><th>What failed</th>
        </tr>
      </thead>
      <tbody>
        {jobs.map((j) => (
          <tr key={j.id} className="border-b align-top">
            <td className="py-2">{formatTime(j.createdAt)}</td>
            <td>{j.identifierFromPurchaser}</td>
            <td>{JOB_STATUS_LABEL[j.status]}</td>
            <td>
              <ul>{reasonsOf(j).map((r) => <li key={r}>{r}</li>)}</ul>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
