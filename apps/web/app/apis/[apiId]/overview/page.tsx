import type { Metadata } from "next";
import { formatHealthReasons } from "@hirakumi/core";
import Link from "next/link";
import { redirect } from "next/navigation";
import { BuyerSnippet } from "@/components/buyer-snippet";
import { HealthBadge } from "@/components/health-badge";
import { LiveMoment } from "@/components/live-moment";
import { LiveProgress } from "@/components/live-progress";
import { RetireButton } from "@/components/retire-button";
import { PackSalesTable } from "@/components/sales-tables";
import { EmptyState, WaitingState } from "@/components/states";
import { TryLiveLink } from "@/components/try-live-link";
import { UpstreamAuthForm } from "@/components/upstream-auth-form";
import { OverviewStatGrid } from "@/components/stat";
import { formatTime } from "@/lib/copy";
import { getSql } from "@/lib/db";
import { env } from "@/lib/env";
import { firstFailedStep, stepForState } from "@/lib/flow";
import { getGateway } from "@/lib/gateway";
import { loadApiPage } from "@/lib/page-auth";
import { listOnboardSteps } from "@/lib/repo/apis";
import { getPack } from "@/lib/repo/packs";
import { listLatestRules } from "@/lib/repo/rules";
import { getUpstreamAuth } from "@/lib/repo/upstream-auth";
import { getOverviewStats, listIncidents, listPackSales } from "@/lib/repo/stats";
import { progressFor } from "@/lib/progress";
import { buildBuyerSnippet } from "@/lib/snippet";
import { isTextPromise } from "@/lib/answer-format";
import { buildTimeline } from "@/lib/timeline";
import { registryLinks } from "@/lib/try";

export const metadata: Metadata = { title: "Overview" };

export default async function OverviewPage({ params }: { params: Promise<{ apiId: string }> }) {
  const { apiId } = await params;
  const { api } = await loadApiPage(apiId, `/apis/${apiId}/overview`);
  if (api.state !== "registering" && api.state !== "live" && api.state !== "retired") {
    redirect(`/apis/${apiId}/${stepForState(api.state)}`);
  }
  const sql = getSql();
  const [stats, incidents, pack, promises, sales, steps, upstreamAuth] = await Promise.all([
    getOverviewStats(sql, apiId), listIncidents(sql, apiId), getPack(sql, apiId),
    listLatestRules(sql, apiId), listPackSales(sql, apiId, 5), listOnboardSteps(sql, apiId), getUpstreamAuth(sql, apiId),
  ]);
  const downReasons = api.state === "live" && api.health === "down"
    ? await getGateway().getHealth(apiId).then((h) => h.lastReasons).catch(() => [])
    : [];
  const publicBase = env.publicBaseUrl();
  const buyerBase = `${publicBase}/a/${apiId}`;
  const snippetOp = promises.find((p) => p.opId === api.escrowOpId) ?? promises[0];
  const progress = progressFor(api, buildTimeline(api.state, steps), firstFailedStep(steps));
  const registerStep = steps.find((s) => s.step === "register" && s.status === "done");

  return (
    <section className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-4">
          <h1 className="text-h font-medium uppercase">{api.name}</h1>
          <HealthBadge state={api.state} health={api.health} checkedAt={api.healthCheckedAt} />
        </div>
        <TryLiveLink apiId={apiId} state={api.state} health={api.health} />
      </div>

      {api.state === "live" && (
        <LiveMoment apiId={apiId} liveSince={registerStep ? new Date(registerStep.updatedAt).toISOString() : null}
          registryUrl={registryLinks(api.agentIdentifier)?.explorerUrl ?? null} health={api.health} />
      )}
      {api.state === "registering" && (
        <WaitingState title="Registering on the Masumi network. This takes about a minute."
          detail="Your API goes Live as soon as the registry lists it." since={progress.timeline.current?.since ?? null}>
          {/* Polls only while registering; once live the overview stays still (no gateway health on every tick). */}
          <LiveProgress apiId={apiId} initial={progress} />
        </WaitingState>
      )}
      {downReasons.length > 0 && (
        <div role="alert" className="rounded-[2px] border-2 border-ink border-l-8 border-l-coral bg-frost p-4 text-body">
          <p className="font-medium">Your API is Down. Buyers get a &quot;try later&quot; answer and no credits are used.</p>
          <ul className="list-disc pl-5">{downReasons.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      )}

      <dl className="grid gap-x-6 gap-y-2 rounded-[2px] border-2 border-ink bg-frost p-4 text-body sm:grid-cols-[200px_1fr]">
        <dt className="text-graphite">Agent ID</dt><dd className="break-all">{api.agentIdentifier ?? "Assigned after registration"}</dd>
        <dt className="text-graphite">Buyer URL</dt><dd className="break-all">{buyerBase}</dd>
        <dt className="text-graphite">Health check URL</dt><dd className="break-all">{`${buyerBase}/availability`}</dd>
        {promises.map((p) => (
          <div key={p.operationId} className="contents">
            <dt className="text-graphite">{`Promise for ${p.method.toUpperCase()} ${p.path}`}</dt>
            <dd className="break-all">{`${publicBase}/r/${p.hash}`}</dd>
          </div>
        ))}
        {api.state === "live" && (<><dt className="text-graphite">Public page</dt><dd><Link href={`/p/${apiId}`} className="underline underline-offset-4">{`/p/${apiId}`}</Link></dd></>)}
      </dl>

      <OverviewStatGrid stats={stats} />

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-sub font-semibold uppercase">Latest pack sales</h2>
          <Link href={`/apis/${apiId}/sales`} className="text-body underline underline-offset-4">See all sales</Link>
        </div>
        <PackSalesTable sales={sales} />
      </div>

      <div className="space-y-3">
        <h2 className="text-sub font-semibold uppercase">Downtime</h2>
        {incidents.length === 0 ? (
          <EmptyState title="No downtime recorded" detail="If your API stops keeping its promise, Hirakumi marks it Down and tells you here." />
        ) : (
          <ul className="space-y-3">
            {incidents.map((i) => (
              <li key={new Date(i.downAt).toISOString()} className="rounded-[2px] border-2 border-ink border-l-8 border-l-coral bg-frost p-4 text-body">
                <p className="font-medium">{`Down from ${formatTime(i.downAt)} ${i.upAt ? `to ${formatTime(i.upAt)}` : "until now"}`}</p>
                <p>{`${i.creditsUsed} credits used while Down. ${i.callsNotPassed} paid calls didn't pass and used no credits.`}</p>
                <ul className="list-disc pl-5 text-graphite">{formatHealthReasons(i.reasons).map((r) => <li key={r}>{r}</li>)}</ul>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-3">
        <h2 className="text-sub font-semibold uppercase">For agent builders</h2>
        {pack && snippetOp ? (
          <BuyerSnippet code={buildBuyerSnippet({
            gatewayBaseUrl: publicBase, apiId, packId: pack.id, packCalls: pack.calls,
            packPriceMicros: pack.priceMicros, opId: snippetOp.opId, method: snippetOp.method, textAnswer: isTextPromise(snippetOp.definition),
          })} />
        ) : (
          <EmptyState title="No buyer code yet" detail="The code appears once your API has a price and a promise." />
        )}
      </div>

      {api.state !== "retired" && (
        // For key rotation: a new key takes effect on the next call, nothing else changes.
        <UpstreamAuthForm apiId={apiId} initial={upstreamAuth} hint={null} title="Your API's key" />
      )}

      {api.state === "live" && <RetireButton apiId={apiId} name={api.name} />}
    </section>
  );
}
