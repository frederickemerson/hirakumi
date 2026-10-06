import Link from "next/link";
import { redirect } from "next/navigation";
import { AutoRefresh } from "@/components/auto-refresh";
import { BuyerSnippet } from "@/components/buyer-snippet";
import { HealthBadge } from "@/components/health-badge";
import { RetireButton } from "@/components/retire-button";
import { PackSalesTable } from "@/components/sales-tables";
import { EmptyState, WaitingState } from "@/components/states";
import { StepList } from "@/components/step-list";
import { formatTime } from "@/lib/copy";
import { getSql } from "@/lib/db";
import { env } from "@/lib/env";
import { stepForState } from "@/lib/flow";
import { getGateway } from "@/lib/gateway";
import { formatTusdm } from "@/lib/money";
import { loadApiPage } from "@/lib/page-auth";
import { listOnboardSteps } from "@/lib/repo/apis";
import { getPack } from "@/lib/repo/packs";
import { listLatestRules } from "@/lib/repo/rules";
import { getOverviewStats, listIncidents, listPackSales } from "@/lib/repo/stats";
import { buildBuyerSnippet } from "@/lib/snippet";

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-lg border p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

function stringReasons(r: unknown): string[] {
  return Array.isArray(r) ? r.filter((x): x is string => typeof x === "string") : [];
}

export default async function OverviewPage({ params }: { params: Promise<{ apiId: string }> }) {
  const { apiId } = await params;
  const { api } = await loadApiPage(apiId, `/apis/${apiId}/overview`);
  if (api.state !== "registering" && api.state !== "live" && api.state !== "retired") {
    redirect(`/apis/${apiId}/${stepForState(api.state)}`);
  }
  const sql = getSql();
  const [stats, incidents, pack, promises, sales, steps] = await Promise.all([
    getOverviewStats(sql, apiId), listIncidents(sql, apiId), getPack(sql, apiId),
    listLatestRules(sql, apiId), listPackSales(sql, apiId, 5), listOnboardSteps(sql, apiId),
  ]);
  const downReasons = api.state === "live" && api.health === "down"
    ? await getGateway().getHealth(apiId).then((h) => h.lastReasons).catch(() => [])
    : [];
  const publicBase = env.publicBaseUrl();
  const buyerBase = `${publicBase}/a/${apiId}`;
  const snippetOp = promises.find((p) => p.opId === api.escrowOpId) ?? promises[0];

  return (
    <section className="space-y-8">
      <AutoRefresh everyMs={5000} />
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">{api.name}</h1>
        <HealthBadge state={api.state} health={api.health} checkedAt={api.healthCheckedAt} />
      </div>

      {api.state === "registering" && (
        <WaitingState title="Registering on the Masumi network. This takes about a minute."
          detail="Your API goes Live as soon as the registry lists it.">
          <StepList steps={steps} />
        </WaitingState>
      )}
      {downReasons.length > 0 && (
        <div role="alert" className="rounded-lg border border-destructive/50 p-4 text-sm">
          <p className="font-medium">Your API is Down. Buyers get a "try later" answer and no credits are used.</p>
          <ul className="list-disc pl-5">{downReasons.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      )}

      <dl className="grid gap-2 text-sm sm:grid-cols-[180px_1fr]">
        <dt className="text-muted-foreground">Agent ID</dt><dd className="break-all">{api.agentIdentifier ?? "Assigned after registration"}</dd>
        <dt className="text-muted-foreground">Buyer URL</dt><dd className="break-all">{buyerBase}</dd>
        <dt className="text-muted-foreground">Health check URL</dt><dd className="break-all">{`${buyerBase}/availability`}</dd>
        {promises.map((p) => (
          <div key={p.operationId} className="contents">
            <dt className="text-muted-foreground">{`Promise for ${p.method.toUpperCase()} ${p.path}`}</dt>
            <dd className="break-all">{`${publicBase}/r/${p.hash}`}</dd>
          </div>
        ))}
        {api.state === "live" && (<><dt className="text-muted-foreground">Public page</dt><dd><Link href={`/p/${apiId}`} className="underline">{`/p/${apiId}`}</Link></dd></>)}
      </dl>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Paid calls, last 24 hours" value={String(stats.callsDay)} />
        <Stat label="Kept the promise" value={stats.passRate === null ? "No paid calls yet" : `${Math.round(stats.passRate * 100)}%`}
          note={`${stats.passDay} passed, ${stats.failDay} didn't (no credit used)`} />
        <Stat label="Pack earnings" value={`${formatTusdm(stats.packEarningsMicros)} tUSDM`} note={`${stats.packSales} packs sold`} />
        <Stat label="Per-job earnings" value={`${formatTusdm(stats.escrowNetMicros)} tUSDM`}
          note={`${stats.escrowJobs} jobs, ${formatTusdm(stats.escrowGrossMicros)} paid, Masumi kept ${formatTusdm(stats.escrowFeeMicros)}`} />
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Latest pack sales</h2>
          <Link href={`/apis/${apiId}/sales`} className="text-sm underline">See all sales</Link>
        </div>
        <PackSalesTable sales={sales} />
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-medium">Downtime</h2>
        {incidents.length === 0 ? (
          <EmptyState title="No downtime recorded" detail="If your API stops keeping its promise, Hirakumi marks it Down and tells you here." />
        ) : (
          <ul className="space-y-3">
            {incidents.map((i) => (
              <li key={new Date(i.downAt).toISOString()} className="rounded-lg border p-4 text-sm">
                <p className="font-medium">{`Down from ${formatTime(i.downAt)} ${i.upAt ? `to ${formatTime(i.upAt)}` : "until now"}`}</p>
                <p>{`${i.creditsUsed} credits used while Down. ${i.callsNotPassed} paid calls didn't pass and used no credits.`}</p>
                <ul className="list-disc pl-5 text-muted-foreground">{stringReasons(i.reasons).map((r) => <li key={r}>{r}</li>)}</ul>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-medium">For agent builders</h2>
        {pack && snippetOp ? (
          <BuyerSnippet code={buildBuyerSnippet({
            gatewayBaseUrl: publicBase, apiId, packId: pack.id, packCalls: pack.calls,
            packPriceMicros: pack.priceMicros, opId: snippetOp.opId, method: snippetOp.method,
          })} />
        ) : (
          <EmptyState title="No buyer code yet" detail="The code appears once your API has a price and a promise." />
        )}
      </div>

      {api.state === "live" && <RetireButton apiId={apiId} />}
    </section>
  );
}
