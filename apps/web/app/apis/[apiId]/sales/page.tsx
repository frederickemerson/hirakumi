import type { Metadata } from "next";
import { EscrowJobsTable, PackSalesTable } from "@/components/sales-tables";
import { getSql } from "@/lib/db";
import { env } from "@/lib/env";
import { loadApiPage } from "@/lib/page-auth";
import { listEscrowJobs, listPackSales } from "@/lib/repo/stats";

export const metadata: Metadata = { title: "Sales" };

export default async function SalesPage({ params }: { params: Promise<{ apiId: string }> }) {
  const { apiId } = await params;
  const { api } = await loadApiPage(apiId, `/apis/${apiId}/sales`);
  const sql = getSql();
  const [sales, jobs] = await Promise.all([listPackSales(sql, apiId), listEscrowJobs(sql, apiId)]);
  return (
    <section className="space-y-8">
      <h1 className="text-h font-medium uppercase">{api.name} sales</h1>
      <div className="space-y-3">
        <h2 className="text-sub font-semibold uppercase">Credit packs</h2>
        <p className="text-body">Pack payments go straight to your wallet in one transaction each.</p>
        <PackSalesTable sales={sales} />
      </div>
      <div className="space-y-3">
        <h2 className="text-sub font-semibold uppercase">Per-job hires (Masumi escrow)</h2>
        <p className="text-body">
          Masumi releases each passed job&apos;s payment after its unlock time and keeps 5%. A failed job is refunded to the buyer automatically.
        </p>
        {env.escrowSweepNotice() && (
          <p role="note" className="border-l-4 border-bill pl-3 text-body">
            During the demo, per-job payments arrive in the Hirakumi collection wallet and we forward them to you by hand.
          </p>
        )}
        <EscrowJobsTable jobs={jobs} />
      </div>
    </section>
  );
}
