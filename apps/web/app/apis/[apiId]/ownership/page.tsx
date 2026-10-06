import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { OwnershipPanel } from "@/components/ownership-panel";
import { getSql } from "@/lib/db";
import { stepForState } from "@/lib/flow";
import { loadApiPage } from "@/lib/page-auth";
import { getOrCreateVerifyCode, hasFreshVerifyPass } from "@/lib/repo/challenges";

export const metadata: Metadata = { title: "Ownership" };

export default async function OwnershipPage({ params }: { params: Promise<{ apiId: string }> }) {
  const { apiId } = await params;
  // loadApiPage 404s unless the signed-in seller owns this API, so the code is only ever shown to its owner.
  const { api } = await loadApiPage(apiId, `/apis/${apiId}/ownership`);
  if (api.state !== "endpoints_confirmed") redirect(`/apis/${apiId}/${stepForState(api.state)}`);
  const sql = getSql();
  const { code } = await getOrCreateVerifyCode(sql, apiId);
  const passed = await hasFreshVerifyPass(sql, apiId);
  return (
    <section className="space-y-6">
      <div className="space-y-3">
        <h1 className="text-h font-medium uppercase">Prove you own this API</h1>
        <p className="max-w-2xl text-body-lg">
          Two quick steps: add a code to your OpenAPI file, then sign once with your wallet.
        </p>
      </div>
      <OwnershipPanel apiId={apiId} openapiUrl={api.openapiUrl} code={code} initiallyPassed={passed} />
    </section>
  );
}
