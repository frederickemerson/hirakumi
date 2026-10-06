import { redirect } from "next/navigation";
import { EndpointsForm } from "@/components/endpoints-form";
import { LiveProgress } from "@/components/live-progress";
import { EmptyState, ErrorState, WaitingState } from "@/components/states";
import { getSql } from "@/lib/db";
import { stepForState } from "@/lib/flow";
import { loadApiPage } from "@/lib/page-auth";
import { listOperations } from "@/lib/repo/operations";
import { loadProgress } from "@/lib/repo/progress";

export default async function EndpointsPage({ params }: { params: Promise<{ apiId: string }> }) {
  const { apiId } = await params;
  const { api } = await loadApiPage(apiId, `/apis/${apiId}/endpoints`);
  const sql = getSql();
  const heading = <h1 className="text-h font-medium uppercase">Choose what to sell</h1>;

  if (api.state === "intake" || api.state === "parsed") {
    const progress = await loadProgress(sql, api);
    const failure = progress.failure;
    if (failure) {
      return (
        <section className="space-y-6">
          {heading}
          <ErrorState title="We couldn't read your API description" detail={failure}
            action={<a href="/apis/new" className="text-body underline underline-offset-4">Try another link</a>} />
        </section>
      );
    }
    return (
      <section className="space-y-6">
        {heading}
        <WaitingState title={api.state === "intake" ? "Reading your API description" : "Describing your endpoints"}
          detail="This usually takes under a minute. This page updates by itself."
          since={progress.timeline.current?.since ?? api.createdAt}>
          <LiveProgress apiId={apiId} initial={progress} />
        </WaitingState>
      </section>
    );
  }
  if (api.state !== "described" && api.state !== "endpoints_confirmed") redirect(`/apis/${apiId}/${stepForState(api.state)}`);

  const operations = await listOperations(sql, apiId);
  return (
    <section className="space-y-6">
      {heading}
      {operations.length === 0 ? (
        <EmptyState title="No endpoints found"
          detail="Your OpenAPI description doesn't list any operations. Add at least one GET operation, then paste the link again."
          action={<a href="/apis/new" className="text-body underline underline-offset-4">Paste a new link</a>} />
      ) : (
        <EndpointsForm apiId={apiId} operations={operations} initialEscrowOpId={api.escrowOpId} />
      )}
    </section>
  );
}
