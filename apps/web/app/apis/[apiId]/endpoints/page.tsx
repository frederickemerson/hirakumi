import { redirect } from "next/navigation";
import { EndpointsForm } from "@/components/endpoints-form";
import { EmptyState, ErrorState, WaitingState } from "@/components/states";
import { StepList } from "@/components/step-list";
import { getSql } from "@/lib/db";
import { firstFailedStep, stepForState } from "@/lib/flow";
import { loadApiPage } from "@/lib/page-auth";
import { listOnboardSteps } from "@/lib/repo/apis";
import { listOperations } from "@/lib/repo/operations";

export default async function EndpointsPage({ params }: { params: Promise<{ apiId: string }> }) {
  const { apiId } = await params;
  const { api } = await loadApiPage(apiId, `/apis/${apiId}/endpoints`);
  const sql = getSql();
  const heading = <h1 className="text-h font-medium uppercase">Choose what to sell</h1>;

  if (api.state === "intake" || api.state === "parsed") {
    const steps = await listOnboardSteps(sql, apiId);
    const failure = firstFailedStep(steps);
    if (failure) {
      return (
        <section className="space-y-6">
          {heading}
          <ErrorState title="We couldn't read your API description" detail={failure}
            action={<a href="/apis/new" className="text-body underline underline-offset-4">Try another link</a>} />
        </section>
      );
    }
    const running = steps.find((s) => s.status === "running");
    return (
      <section className="space-y-6">
        {heading}
        <WaitingState title="Reading your API description" detail="This usually takes under a minute. This page updates by itself."
          since={running?.updatedAt ?? api.createdAt}>
          <StepList steps={steps} />
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
