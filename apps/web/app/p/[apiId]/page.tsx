import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BuyerSnippet } from "@/components/buyer-snippet";
import { HealthBadge } from "@/components/health-badge";
import { StatusPanel } from "@/components/status-panel";
import { TryLiveLink } from "@/components/try-live-link";
import { Badge } from "@/components/ui/badge";
import { getSql } from "@/lib/db";
import { loadLiveApi } from "@/lib/public-api";
import { env } from "@/lib/env";
import { getGateway } from "@/lib/gateway";
import { settlementLine, type PackSettlement } from "@/lib/settlement";
import { formatTusdm } from "@/lib/money";
import { getPack } from "@/lib/repo/packs";
import { listLatestRules } from "@/lib/repo/rules";
import { listIncidents } from "@/lib/repo/stats";
import { getPublicStatus } from "@/lib/repo/status";
import { buildBuyerSnippet } from "@/lib/snippet";
import { isTextPromise, promiseFormatNote } from "@/lib/answer-format";

export async function generateMetadata({ params }: { params: Promise<{ apiId: string }> }): Promise<Metadata> {
  const api = await loadLiveApi((await params).apiId);
  return { title: api ? `${api.name} status` : "Not found" };
}

/** The settlement line is extra: if the gateway can't answer, the page renders without it. */
async function settlementsOf(apiId: string): Promise<PackSettlement[]> {
  try {
    return await getGateway().getSettlement(apiId);
  } catch {
    return [];
  }
}

export default async function PublicApiPage({ params }: { params: Promise<{ apiId: string }> }) {
  const { apiId } = await params;
  const sql = getSql();
  const api = await loadLiveApi(apiId);
  if (!api) notFound();
  const [pack, promises, status, incidents, settlements] = await Promise.all([
    getPack(sql, apiId), listLatestRules(sql, apiId), getPublicStatus(sql, apiId), listIncidents(sql, apiId),
    settlementsOf(apiId),
  ]);
  const settlement = pack ? settlements.find((s) => s.packId === pack.id) : undefined;
  const op = promises.find((p) => p.opId === api.escrowOpId) ?? promises[0];
  const publicBase = env.publicBaseUrl();
  return (
    <section className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="space-y-3">
          <p className="text-caption font-medium uppercase tracking-[0.06em] text-graphite">Public status page</p>
          <div className="flex flex-wrap items-center gap-4">
            <h1 className="text-h font-normal uppercase sm:text-h-lg">{api.name}</h1>
            <HealthBadge state={api.state} health={api.health} checkedAt={api.healthCheckedAt} />
          </div>
          <p className="max-w-2xl text-body-lg text-graphite">What Hirakumi&apos;s monitor saw in the last 24 hours, and the promise every paid answer is checked against.</p>
        </div>
        <TryLiveLink apiId={apiId} state={api.state} health={api.health} />
      </div>
      <StatusPanel status={status} incidents={incidents} />
      {pack && (
        <p className="rounded-[2px] border-2 border-ink bg-canary p-5 text-body-lg">
          <span className="font-semibold">{`${pack.calls} calls for ${formatTusdm(pack.priceMicros)} tUSDM`}</span>
          {", paid once on Cardano preprod. A credit is used only when the answer keeps the promise."}
          {settlement && <span className="mt-2 block text-body" data-testid="settlement">{settlementLine(settlement)}</span>}
        </p>
      )}
      <div className="space-y-3">
        <h2 className="text-sub font-semibold uppercase">The promise</h2>
        <ul className="space-y-3">
          {promises.map((p) => (
            <li key={p.operationId} className="space-y-2 rounded-[2px] border-2 border-ink bg-frost p-5">
              <p className="flex items-center gap-2 text-body-lg"><Badge variant="sky">{p.method.toUpperCase()}</Badge><code>{p.path}</code></p>
              <p className="text-body-lg">{p.plainEnglish ?? "See the exact check below."}</p>
              {promiseFormatNote(p.definition) && <p className="text-body text-graphite">{promiseFormatNote(p.definition)}</p>}
              <a href={`${publicBase}/r/${p.hash}`} className="inline-block text-body underline underline-offset-4">The exact check (JSON)</a>
            </li>
          ))}
        </ul>
      </div>
      {pack && op && (
        <div id="buyer-snippet" className="scroll-mt-6 space-y-3">
          <h2 className="text-sub font-semibold uppercase">For agent builders</h2>
          <BuyerSnippet code={buildBuyerSnippet({
            gatewayBaseUrl: publicBase, apiId, packId: pack.id, packCalls: pack.calls,
            packPriceMicros: pack.priceMicros, opId: op.opId, method: op.method, textAnswer: isTextPromise(op.definition),
          })} />
        </div>
      )}
    </section>
  );
}
