import type { Metadata } from "next";
import Link from "next/link";
import { HealthBadge } from "@/components/health-badge";
import { SellerTryLive } from "@/components/seller-try-live";
import { EmptyState } from "@/components/states";
import type { TryOp } from "@/components/try-console";
import { TRY_DOWN_REASON } from "@/components/try-live-link";
import { SELF_PAY_LINE } from "@/components/wallet-pay";
import { getSql } from "@/lib/db";
import { loadApiPage } from "@/lib/page-auth";
import { getPack } from "@/lib/repo/packs";
import { listLatestRules } from "@/lib/repo/rules";
import { UPDATING } from "@/lib/repo/schema";
import { hasSelfTestSchema } from "@/lib/repo/self-test-schema";
import { findSelfTestPack, getSelfTestStatus } from "@/lib/self-test-repo";
import { fieldsFromSchema } from "@/lib/try";
import { listTryOperations } from "@/lib/try-repo";

export const metadata: Metadata = { title: "Try it live" };

/** The seller's own Try it live: call their live API through the real gateway, like a buyer. */
export default async function SellerTryPage({ params }: { params: Promise<{ apiId: string }> }) {
  const { apiId } = await params;
  const { session, api } = await loadApiPage(apiId, `/apis/${apiId}/try`);
  if (api.state !== "live") {
    return (
      <section className="space-y-6">
        <h1 className="text-h font-medium uppercase">Try it live</h1>
        <EmptyState title="Try it live opens once your API is live." detail="Finish the listing steps and publish it first." />
      </section>
    );
  }
  const sql = getSql();
  if (!(await hasSelfTestSchema(sql))) {
    return (
      <section className="space-y-6">
        <h1 className="text-h font-medium uppercase">Try it live</h1>
        <EmptyState title={UPDATING} detail="Your API keeps serving buyers meanwhile." />
      </section>
    );
  }
  const [rows, rules, pack, offer, status] = await Promise.all([
    listTryOperations(sql, apiId), listLatestRules(sql, apiId), findSelfTestPack(sql, apiId, session.sellerId),
    getPack(sql, apiId), getSelfTestStatus(sql, apiId, session.sellerId),
  ]);
  const ops: TryOp[] = rows.map((r) => {
    const rule = rules.find((p) => p.opId === r.opId);
    return {
      opId: r.opId, method: r.method, path: r.path, description: r.description,
      promise: rule?.plainEnglish ?? null, statusOnly: rule?.statusOnly ?? false, fields: fieldsFromSchema(r.inputSchema),
    };
  });
  const freeTest = !status.freeTestUsed && status.freeTestsLeft > 0;

  return (
    <section className="space-y-8">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-4">
          <h1 className="text-h font-medium uppercase">Try {api.name} live</h1>
          <HealthBadge state={api.state} health={api.health} checkedAt={api.healthCheckedAt} />
        </div>
        <p className="max-w-2xl text-body-lg text-graphite">
          Call your API through Hirakumi the way a buyer does: a real pack, real payments on Cardano preprod, a receipt for every call.
        </p>
      </div>

      <div className="grid gap-4 rounded-[2px] border-2 border-ink border-l-8 border-l-bill bg-frost p-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start" data-testid="who-pays">
        <div className="space-y-1">
          <p className="text-caption font-semibold uppercase tracking-[0.04em]">Who pays</p>
          {freeTest ? (
            <p className="text-body">Your first test is free: Hirakumi&apos;s demo wallet buys one pack. After that, you pay with your own wallet.</p>
          ) : (
            <p className="text-body">{SELF_PAY_LINE}</p>
          )}
          <p className="text-body text-graphite">Tests never count as sales, money received or pass rate.</p>
        </div>
        <p className="text-caption text-graphite sm:text-right">
          {status.freeTestUsed ? "Free test used" : `${status.freeTestsLeft} free ${status.freeTestsLeft === 1 ? "test" : "tests"} left`}
          <br />
          <Link href={`/p/${apiId}`} className="underline underline-offset-4">Public page</Link>
        </p>
      </div>

      <SellerTryLive
        apiId={apiId}
        ops={ops}
        initialPack={pack ? { credits: pack.remaining, txHash: pack.txHash, pending: pack.pending } : null}
        packPrice={offer ? { calls: offer.calls, priceMicros: offer.priceMicros } : null}
        downReason={api.health === "down" ? TRY_DOWN_REASON : null}
        freeTest={freeTest}
        freeTestsLeft={status.freeTestsLeft}
      />
    </section>
  );
}
