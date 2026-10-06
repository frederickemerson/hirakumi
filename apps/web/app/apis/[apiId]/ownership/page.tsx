import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { OwnershipPanel } from "@/components/ownership-panel";
import { UpstreamAuthForm } from "@/components/upstream-auth-form";
import { getSql } from "@/lib/db";
import { apiBaseUrl } from "@/lib/copy";
import { stepForState } from "@/lib/flow";
import { loadApiPage } from "@/lib/page-auth";
import { ErrorState, NoticeList } from "@/components/states";
import { listingBaseNotes } from "@/lib/repo/apis";
import { getOrCreateVerifyCode, hasFreshVerifyPass } from "@/lib/repo/challenges";
import { getAuthHint, getUpstreamAuth } from "@/lib/repo/upstream-auth";

export const metadata: Metadata = { title: "Ownership" };

export default async function OwnershipPage({ params }: { params: Promise<{ apiId: string }> }) {
  const { apiId } = await params;
  // loadApiPage 404s unless the signed-in seller owns this API, so the code is only ever shown to its owner.
  const { api } = await loadApiPage(apiId, `/apis/${apiId}/ownership`);
  if (api.state !== "endpoints_confirmed") redirect(`/apis/${apiId}/${stepForState(api.state)}`);
  const sql = getSql();
  const { code } = await getOrCreateVerifyCode(sql, apiId);
  const [passed, notes, upstreamAuth, authHint] = await Promise.all([
    hasFreshVerifyPass(sql, apiId), listingBaseNotes(sql, apiId), getUpstreamAuth(sql, apiId), getAuthHint(sql, apiId),
  ]);
  return (
    <section className="space-y-6">
      <div className="space-y-3">
        <h1 className="text-h font-medium uppercase">Prove you own this API</h1>
        <p className="max-w-2xl text-body-lg">
          Two quick steps: make your API send a header with a code, then sign once with your wallet.
        </p>
      </div>
      {notes.blocked && <ErrorState title="You can't list this API yet" detail={notes.blocked} />}
      <NoticeList items={notes.warnings} />
      <OwnershipPanel apiId={apiId} baseUrl={apiBaseUrl(api)} code={code} initiallyPassed={passed}
        beforeSigning={<UpstreamAuthForm apiId={apiId} initial={upstreamAuth} hint={authHint} />} />
    </section>
  );
}
