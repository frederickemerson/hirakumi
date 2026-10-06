import { httpChallengePath } from "@hirakumi/core";
import { redirect } from "next/navigation";
import { OwnershipPanel } from "@/components/ownership-panel";
import { getSql } from "@/lib/db";
import { stepForState } from "@/lib/flow";
import { loadApiPage } from "@/lib/page-auth";
import { hasPassedHttpChallenge } from "@/lib/repo/challenges";

export default async function OwnershipPage({ params }: { params: Promise<{ apiId: string }> }) {
  const { apiId } = await params;
  const { api } = await loadApiPage(apiId, `/apis/${apiId}/ownership`);
  if (api.state !== "endpoints_confirmed") redirect(`/apis/${apiId}/${stepForState(api.state)}`);
  const passed = await hasPassedHttpChallenge(getSql(), apiId);
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Prove you own this API</h1>
      <p className="text-muted-foreground">
        Two quick checks stop anyone from selling someone else's API: a file on your server, and one signature from your wallet.
      </p>
      <OwnershipPanel apiId={apiId} fileUrl={`${api.origin}${httpChallengePath(apiId)}`} initiallyPassed={passed} />
    </section>
  );
}
