import { redirect } from "next/navigation";
import { ReviewPanel } from "@/components/review-panel";
import { ErrorState, WaitingState } from "@/components/states";
import { StepList } from "@/components/step-list";
import { getSql } from "@/lib/db";
import { firstFailedStep, stepForState } from "@/lib/flow";
import { loadApiPage } from "@/lib/page-auth";
import { listOnboardSteps } from "@/lib/repo/apis";
import { getPack } from "@/lib/repo/packs";
import { listLatestRules } from "@/lib/repo/rules";

export default async function ReviewPage({ params }: { params: Promise<{ apiId: string }> }) {
  const { apiId } = await params;
  const { api } = await loadApiPage(apiId, `/apis/${apiId}/review`);
  const sql = getSql();
  const heading = <h1 className="text-2xl font-semibold">Review and publish</h1>;

  if (api.state === "ownership_verified") {
    const steps = await listOnboardSteps(sql, apiId);
    const failure = firstFailedStep(steps);
    return (
      <section className="space-y-4">
        {heading}
        {failure ? (
          <ErrorState title="Your test calls didn't pass" detail={failure} />
        ) : (
          <WaitingState title="Running test calls on your API"
            detail="Hirakumi calls each endpoint at least 5 times to learn what a good response looks like. This page updates by itself.">
            <StepList steps={steps} />
          </WaitingState>
        )}
      </section>
    );
  }
  if (api.state !== "rule_built" && api.state !== "priced") redirect(`/apis/${apiId}/${stepForState(api.state)}`);

  const [promises, pack] = await Promise.all([listLatestRules(sql, apiId), getPack(sql, apiId)]);
  return (
    <section className="space-y-4">
      {heading}
      {promises.length === 0 ? (
        <WaitingState title="Writing your promise" detail="The test calls finished; the promise appears here in a moment." />
      ) : (
        <ReviewPanel apiId={apiId} state={api.state} promises={promises} pack={pack} />
      )}
    </section>
  );
}
