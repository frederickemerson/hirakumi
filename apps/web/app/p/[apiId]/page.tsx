import { notFound } from "next/navigation";
import { BuyerSnippet } from "@/components/buyer-snippet";
import { HealthBadge } from "@/components/health-badge";
import { StatusPanel } from "@/components/status-panel";
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
    <section className="space-y-6">
      <div className="flex items-center gap-4">
        <h1 className="text-2xl font-semibold">{api.name}</h1>
        <HealthBadge state={api.state} health={api.health} checkedAt={api.healthCheckedAt} />
      </div>
      <StatusPanel status={status} incidents={incidents} />
      {pack && <p>{`${pack.calls} credits for ${formatTusdm(pack.priceMicros)} tUSDM, paid once on Cardano preprod. A credit is used only when the response keeps the promise.`}</p>}
      <ul className="space-y-2">
        {promises.map((p) => (
          <li key={p.operationId} className="rounded-lg border p-4">
            <p className="font-mono text-sm">{p.method.toUpperCase()} {p.path}</p>
            <p>{p.plainEnglish ?? "See the exact check below."}</p>
            <a href={`${publicBase}/r/${p.hash}`} className="text-sm underline">The exact check (JSON)</a>
          </li>
        ))}
      </ul>
      {pack && op && (
        <BuyerSnippet code={buildBuyerSnippet({
          gatewayBaseUrl: publicBase, apiId, packId: pack.id, packCalls: pack.calls,
          packPriceMicros: pack.priceMicros, opId: op.opId, method: op.method,
        })} />
      )}
    </section>
  );
}
