import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { HealthBadge } from "@/components/health-badge";
import { RegistryCard } from "@/components/registry-card";
import { OverviewStatGrid } from "@/components/stat";
import { StatusPanel } from "@/components/status-panel";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { getSql } from "@/lib/db";
import { DEMO_API_ID } from "@/lib/demo";
import { env } from "@/lib/env";
import { formatTusdm } from "@/lib/money";
import { getLiveApi } from "@/lib/repo/apis";
import { getPack } from "@/lib/repo/packs";
import { listLatestRules } from "@/lib/repo/rules";
import { getOverviewStats, listIncidents } from "@/lib/repo/stats";
import { getPublicStatus } from "@/lib/repo/status";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Demo seller" };

/**
 * A read-only look at the demo seller's live API, for anyone without a preprod wallet. It shows only
 * what is already public (status, promise, registry) plus the aggregate overview numbers. Nothing
 * seller-private: no wallet address, no buyer addresses, no chat, no controls.
 */
export default async function DemoSellerPage() {
  const sql = getSql();
  const api = await getLiveApi(sql, DEMO_API_ID);
  if (!api) notFound();
  const [stats, pack, promises, status, incidents] = await Promise.all([
    getOverviewStats(sql, api.id), getPack(sql, api.id), listLatestRules(sql, api.id),
    getPublicStatus(sql, api.id), listIncidents(sql, api.id),
  ]);
  const publicBase = env.publicBaseUrl();

  return (
    <section className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="space-y-3">
          <p className="text-caption font-medium uppercase tracking-[0.06em] text-graphite">Demo seller, read-only</p>
          <div className="flex flex-wrap items-center gap-4">
            <h1 className="text-h font-normal uppercase sm:text-h-lg">{api.name}</h1>
            <HealthBadge state={api.state} health={api.health} checkedAt={api.healthCheckedAt} />
          </div>
          <p className="max-w-2xl text-body-lg text-graphite">
            A live API listed through Hirakumi on Cardano preprod. This is the seller&apos;s overview without the private parts.
          </p>
        </div>
        <div className="flex flex-wrap gap-4">
          <Link href={`/p/${api.id}/try`} className={buttonVariants()}>Try it live</Link>
          <Link href={`/p/${api.id}`} className={buttonVariants({ variant: "outline" })}>Public status page</Link>
        </div>
      </div>

      <OverviewStatGrid stats={stats} />

      {pack && (
        <p className="rounded-[2px] border-2 border-ink bg-canary p-5 text-body-lg">
          <span className="font-semibold">{`${pack.calls} calls for ${formatTusdm(pack.priceMicros)} tUSDM`}</span>
          {", paid once on Cardano preprod. A credit is used only when the answer keeps the promise."}
        </p>
      )}

      <div className="space-y-3">
        <h2 className="text-sub font-semibold uppercase">The promise</h2>
        <ul className="space-y-3">
          {promises.map((p) => (
            <li key={p.operationId} className="space-y-2 rounded-[2px] border-2 border-ink bg-frost p-5">
              <p className="flex items-center gap-2 text-body-lg"><Badge variant="sky">{p.method.toUpperCase()}</Badge><code>{p.path}</code></p>
              <p className="text-body-lg">{p.plainEnglish ?? "See the exact check below."}</p>
              <a href={`${publicBase}/r/${p.hash}`} className="inline-block text-body underline underline-offset-4">The exact check (JSON)</a>
            </li>
          ))}
        </ul>
      </div>

      <StatusPanel status={status} incidents={incidents} />
      <RegistryCard agentIdentifier={api.agentIdentifier} agentBaseUrl={`${publicBase}/a/${api.id}`} />

      <div className="flex flex-wrap items-center justify-between gap-4 rounded-[2px] border-2 border-ink bg-ice p-5">
        <p className="text-body-lg">Ready to list your own API?</p>
        <Link href="/login" className={buttonVariants()}>List your API</Link>
      </div>
    </section>
  );
}
