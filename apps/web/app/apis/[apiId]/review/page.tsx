import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ReviewPanel } from "@/components/review-panel";
import { LiveProgress } from "@/components/live-progress";
import { ErrorState, WaitingState } from "@/components/states";
import { getSql } from "@/lib/db";
import { stepForState } from "@/lib/flow";
import { loadApiPage } from "@/lib/page-auth";
import { loadProgress } from "@/lib/repo/progress";
import { getPack } from "@/lib/repo/packs";
import { listLatestRules } from "@/lib/repo/rules";

export const metadata: Metadata = { title: "Review and price" };

export default async function ReviewPage({ params }: { params: Promise<{ apiId: string }> }) {
  const { apiId } = await params;
  const { api } = await loadApiPage(apiId, `/apis/${apiId}/review`);
  const sql = getSql();
  const heading = <h1 className="text-h font-medium uppercase">Review and publish</h1>;

  if (api.state === "ownership_verified") {
    const progress = await loadProgress(sql, api);
    const failure = progress.failure;
    return (
      <section className="space-y-6">
        {heading}
        {failure ? (
          <ErrorState title="Your test calls didn't pass" detail={failure} />
        ) : (
          <WaitingState title="Running test calls on your API"
            detail="Hirakumi calls each endpoint at least 5 times to learn what a good answer looks like. This page updates by itself."
            since={progress.timeline.current?.since ?? null}>
            <LiveProgress apiId={apiId} initial={progress} />
          </WaitingState>
        )}
      </section>
    );
  }
  if (api.state !== "rule_built" && api.state !== "priced") redirect(`/apis/${apiId}/${stepForState(api.state)}`);

  const [promises, pack] = await Promise.all([listLatestRules(sql, apiId), getPack(sql, apiId)]);
  return (
    <section className="space-y-6">
      {heading}
      {promises.length === 0 ? (
        <WaitingState title="Writing your promise" detail="The test calls finished; the promise appears here in a moment." />
      ) : (
        <ReviewPanel apiId={apiId} state={api.state} promises={promises} pack={pack} />
      )}
    </section>
  );
}
