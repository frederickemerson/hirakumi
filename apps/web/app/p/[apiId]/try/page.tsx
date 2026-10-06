import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HealthBadge } from "@/components/health-badge";
import { RegistryCard } from "@/components/registry-card";
import { TryConsole, type TryOp } from "@/components/try-console";
import { TRY_DOWN_REASON } from "@/components/try-live-link";
import { getSql } from "@/lib/db";
import { loadLiveApi } from "@/lib/public-api";
import { env } from "@/lib/env";
import { getPack } from "@/lib/repo/packs";
import { listLatestRules } from "@/lib/repo/rules";
import { envTryToken, fieldsFromSchema } from "@/lib/try";
import { findTryPack, listTryOperations } from "@/lib/try-repo";
import { isLiveBuyApi } from "@/lib/try-live";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ apiId: string }> }): Promise<Metadata> {
  const api = await loadLiveApi((await params).apiId);
  return { title: api ? `Try ${api.name} live` : "Not found" };
}

export default async function TryApiPage({ params }: { params: Promise<{ apiId: string }> }) {
  const { apiId } = await params;
  const sql = getSql();
  const api = await loadLiveApi(apiId);
  if (!api) notFound();
  const [rows, rules, pack, offer] = await Promise.all([
    listTryOperations(sql, apiId), listLatestRules(sql, apiId), findTryPack(sql, apiId, envTryToken(apiId)), getPack(sql, apiId),
  ]);
  const ops: TryOp[] = rows.map((r) => ({
    opId: r.opId,
    method: r.method,
    path: r.path,
    description: r.description,
    promise: rules.find((p) => p.opId === r.opId)?.plainEnglish ?? null,
    statusOnly: rules.find((p) => p.opId === r.opId)?.statusOnly ?? false,
    fields: fieldsFromSchema(r.inputSchema),
  }));
  return (
    <section className="space-y-8">
      <div className="space-y-3">
        <p className="text-caption font-medium uppercase tracking-[0.06em] text-graphite">
          <Link href={`/p/${apiId}`} className="underline-offset-4 hover:underline">{api.name}</Link> / Try it live
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <h1 className="text-h font-normal uppercase sm:text-h-lg">Try {api.name} live</h1>
          <HealthBadge state={api.state} health={api.health} checkedAt={api.healthCheckedAt} />
        </div>
        <p className="max-w-2xl text-body-lg text-graphite">
          Use it like a real agent: buy a credit pack with a real payment on Cardano preprod, then call the API through Hirakumi.
          A credit is used only when the answer keeps the promise.
        </p>
      </div>
      <TryConsole
        apiId={apiId}
        ops={ops}
        initialPack={pack ? { credits: pack.remaining, txHash: pack.txHash, pending: pack.pending } : null}
        packPrice={offer ? { calls: offer.calls, priceMicros: offer.priceMicros } : null}
        downReason={api.health === "down" ? TRY_DOWN_REASON : null}
        liveBuy={isLiveBuyApi(apiId)}
      />
      <RegistryCard agentIdentifier={api.agentIdentifier} agentBaseUrl={`${env.publicBaseUrl()}/a/${apiId}`} />
    </section>
  );
}
