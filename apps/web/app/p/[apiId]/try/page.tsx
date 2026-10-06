import Link from "next/link";
import { notFound } from "next/navigation";
import { HealthBadge } from "@/components/health-badge";
import { RegistryCard } from "@/components/registry-card";
import { TryConsole, type TryOp } from "@/components/try-console";
import { getSql } from "@/lib/db";
import { env } from "@/lib/env";
import { getLiveApi } from "@/lib/repo/apis";
import { listLatestRules } from "@/lib/repo/rules";
import { fieldsFromSchema, parseTryTokens } from "@/lib/try";
import { demoCreditsLeft, listTryOperations } from "@/lib/try-repo";

export const dynamic = "force-dynamic";

export default async function TryApiPage({ params }: { params: Promise<{ apiId: string }> }) {
  const { apiId } = await params;
  const sql = getSql();
  const api = await getLiveApi(sql, apiId);
  if (!api) notFound();
  const [rows, rules] = await Promise.all([listTryOperations(sql, apiId), listLatestRules(sql, apiId)]);
  const ops: TryOp[] = rows.map((r) => ({
    opId: r.opId,
    method: r.method,
    path: r.path,
    description: r.description,
    promise: rules.find((p) => p.opId === r.opId)?.plainEnglish ?? null,
    fields: fieldsFromSchema(r.inputSchema),
  }));
  const demoToken = parseTryTokens(process.env.TRY_CREDIT_TOKENS)[apiId];
  const creditsLeft = demoToken ? await demoCreditsLeft(sql, demoToken) : null;
  const hasDemoCredits = creditsLeft !== null;
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
          {hasDemoCredits
            ? "Each paid try uses one real credit from a demo pack bought on Cardano preprod. The credit is only used when the answer keeps the promise."
            : "This API has no demo credits left, so you can see the payment offer an agent gets, but not a paid answer."}
        </p>
      </div>
      <TryConsole apiId={apiId} ops={ops} hasDemoCredits={hasDemoCredits} initialCredits={creditsLeft} />
      <RegistryCard agentIdentifier={api.agentIdentifier} agentBaseUrl={`${env.publicBaseUrl()}/a/${apiId}`} />
    </section>
  );
}
