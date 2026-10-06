import Link from "next/link";
import { notFound } from "next/navigation";
import { BuyerSnippet } from "@/components/buyer-snippet";
import { HealthBadge } from "@/components/health-badge";
import { StatusPanel } from "@/components/status-panel";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { getSql } from "@/lib/db";
import { env } from "@/lib/env";
import { formatTusdm } from "@/lib/money";
import { getLiveApi } from "@/lib/repo/apis";
import { getPack } from "@/lib/repo/packs";
import { listLatestRules } from "@/lib/repo/rules";
import { listIncidents } from "@/lib/repo/stats";
import { getPublicStatus } from "@/lib/repo/status";
import { buildBuyerSnippet } from "@/lib/snippet";

export default async function PublicApiPage({ params }: { params: Promise<{ apiId: string }> }) {
  const { apiId } = await params;
  const sql = getSql();
  const api = await getLiveApi(sql, apiId);
  if (!api) notFound();
  const [pack, promises, status, incidents] = await Promise.all([
    getPack(sql, apiId), listLatestRules(sql, apiId), getPublicStatus(sql, apiId), listIncidents(sql, apiId),
  ]);
  const op = promises.find((p) => p.opId === api.escrowOpId) ?? promises[0];
  const publicBase = env.publicBaseUrl();
  return (
    <section className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-4">
          <h1 className="text-h font-medium uppercase">{api.name}</h1>
          <HealthBadge state={api.state} health={api.health} checkedAt={api.healthCheckedAt} />
        </div>
        <Link href={`/p/${apiId}/try`} className={buttonVariants({ variant: "outline", size: "sm" })}>Try it live</Link>
      </div>
      <StatusPanel status={status} incidents={incidents} />
      {pack && (
        <p className="rounded-[2px] border-2 border-ink bg-canary p-4 text-body-lg">
          {`${pack.calls} credits for ${formatTusdm(pack.priceMicros)} tUSDM, paid once on Cardano preprod. A credit is used only when the response keeps the promise.`}
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
      {pack && op && (
        <div className="space-y-3">
          <h2 className="text-sub font-semibold uppercase">For agent builders</h2>
          <BuyerSnippet code={buildBuyerSnippet({
            gatewayBaseUrl: publicBase, apiId, packId: pack.id, packCalls: pack.calls,
            packPriceMicros: pack.priceMicros, opId: op.opId, method: op.method,
          })} />
        </div>
      )}
    </section>
  );
}
