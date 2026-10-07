import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { OwnershipPanel } from "@/components/ownership-panel";
import { UpstreamAuthForm } from "@/components/upstream-auth-form";
import { verifyRecordFor } from "@hirakumi/core";
import { getSql } from "@/lib/db";
import { stepForState } from "@/lib/flow";
import { loadApiPage } from "@/lib/page-auth";
import { EmptyState, ErrorState, NoticeList } from "@/components/states";
import { listingBaseNotes } from "@/lib/repo/apis";
import { getOrCreateVerifyCode, hasFreshVerifyPass } from "@/lib/repo/challenges";
import { hasDnsVerifySchema, UPDATING } from "@/lib/repo/schema";
import { getAuthHint, getUpstreamAuth } from "@/lib/repo/upstream-auth";
import { probeDns } from "./probe-dns";

export const metadata: Metadata = { title: "Ownership" };

export default async function OwnershipPage({ params }: { params: Promise<{ apiId: string }> }) {
  const { apiId } = await params;
  // loadApiPage 404s unless the signed-in seller owns this API, so the code is only ever shown to its owner.
  const { api } = await loadApiPage(apiId, `/apis/${apiId}/ownership`);
  if (api.state !== "endpoints_confirmed") redirect(`/apis/${apiId}/${stepForState(api.state)}`);
  const sql = getSql();
  const heading = (
    <div className="space-y-3">
      <h1 className="text-h font-medium uppercase">Prove you own this API</h1>
      <p className="max-w-2xl text-body-lg">
        Two quick steps: add one DNS record, then sign once with your wallet.
      </p>
    </div>
  );
  // The code is a challenge of kind 'dns', which needs migrations 0014, 0015 and 0018 (lib/repo/schema.ts).
  if (!(await hasDnsVerifySchema(sql))) {
    return (
      <section className="space-y-6">
        {heading}
        <EmptyState title="Being updated" detail={UPDATING} />
      </section>
    );
  }
  const record = verifyRecordFor(api.origin);
  if (!record.ok) {
    return (
      <section className="space-y-6">
        {heading}
        <ErrorState title="This address can't be proven with DNS" detail={`${record.detail} Change it in your API's setup.`} />
      </section>
    );
  }
  const { code } = await getOrCreateVerifyCode(sql, apiId);
  const [passed, notes, upstreamAuth, authHint] = await Promise.all([
    hasFreshVerifyPass(sql, apiId), listingBaseNotes(sql, apiId), getUpstreamAuth(sql, apiId), getAuthHint(sql, apiId),
  ]);
  // Not awaited: the page renders now and the hint streams in. It only says where to add the record.
  const dns = passed ? undefined : probeDns(record.host, record.name);
  return (
    <section className="space-y-6">
      {heading}
      {notes.blocked && <ErrorState title="You can't list this API yet" detail={notes.blocked} />}
      <NoticeList items={notes.warnings} />
      <OwnershipPanel apiId={apiId} host={record.host} recordName={record.name} code={code} initiallyPassed={passed}
        dns={dns}
        beforeSigning={<UpstreamAuthForm apiId={apiId} initial={upstreamAuth} hint={authHint} />} />
    </section>
  );
}
