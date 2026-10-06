import { EscrowJobsTable, PackSalesTable } from "@/components/sales-tables";
import { getSql } from "@/lib/db";
import { env } from "@/lib/env";
import { loadApiPage } from "@/lib/page-auth";
import { listEscrowJobs, listPackSales } from "@/lib/repo/stats";

export default async function SalesPage({ params }: { params: Promise<{ apiId: string }> }) {
  const { apiId } = await params;
  await loadApiPage(apiId, `/apis/${apiId}/sales`);
  const sql = getSql();
  const [sales, jobs] = await Promise.all([listPackSales(sql, apiId), listEscrowJobs(sql, apiId)]);
  return (
    <section className="space-y-8">
      <h1 className="text-2xl font-semibold">Sales</h1>
      <div className="space-y-3">
        <h2 className="text-lg font-medium">Credit packs</h2>
        <p className="text-sm text-muted-foreground">Pack payments go straight to your wallet in one transaction each.</p>
        <PackSalesTable sales={sales} />
      </div>
      <div className="space-y-3">
        <h2 className="text-lg font-medium">Per-job hires (Masumi escrow)</h2>
        <p className="text-sm text-muted-foreground">
          Masumi releases each passed job's payment after its unlock time and keeps 5%. A failed job is refunded to the buyer automatically.
        </p>
        {env.escrowSweepNotice() && (
          <p role="note" className="text-sm text-amber-700">
            During the demo, per-job earnings arrive in the Hirakumi collection wallet and we forward them to you by hand.
          </p>
        )}
        <EscrowJobsTable jobs={jobs} />
      </div>
    </section>
  );
}
