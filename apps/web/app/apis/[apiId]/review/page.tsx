import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ExposureCard, KEY_FORM_ID } from "@/components/exposure-card";
import { ReviewPanel } from "@/components/review-panel";
import { LiveProgress } from "@/components/live-progress";
import { ProtectLink } from "@/components/protect-link";
import { UpstreamAuthForm } from "@/components/upstream-auth-form";
import { ErrorState, NoticeList, WaitingState } from "@/components/states";
import { getSql } from "@/lib/db";
import { env } from "@/lib/env";
import { stepForState } from "@/lib/flow";
import { loadApiPage } from "@/lib/page-auth";
import { listingBaseNotes } from "@/lib/repo/apis";
import { getFrontDoorSummary } from "@/lib/repo/front-door";
import { getStoredExposure } from "@/lib/repo/exposure";
import { loadProgress } from "@/lib/repo/progress";
import { getPack } from "@/lib/repo/packs";
import { hasAnyApiSchema } from "@/lib/repo/schema";
import { getAuthHint, getUpstreamAuth } from "@/lib/repo/upstream-auth";
import { getSuggestedPhrases, listLatestRules } from "@/lib/repo/rules";

export const metadata: Metadata = { title: "Review and price" };

export default async function ReviewPage({ params }: { params: Promise<{ apiId: string }> }) {
  const { apiId } = await params;
  const { api } = await loadApiPage(apiId, `/apis/${apiId}/review`);
  const sql = getSql();
  const heading = <h1 className="text-h font-medium uppercase">Review and publish</h1>;
  const overlaps = <NoticeList items={(await listingBaseNotes(sql, apiId)).warnings} />;
  // Before migration 0014 no key can be stored, so the key form is hidden (lib/repo/schema.ts).
  const keysOn = await hasAnyApiSchema(sql);

  if (api.state === "ownership_verified") {
    const progress = await loadProgress(sql, api);
    const failure = progress.failure;
    // A missing or wrong key is the usual reason test calls fail, so the key can be fixed here and they run again.
    const [upstreamAuth, authHint] = failure ? await Promise.all([getUpstreamAuth(sql, apiId), getAuthHint(sql, apiId)]) : [null, null];
    return (
      <section className="space-y-6">
        {heading}
        {overlaps}
        {failure ? (
          <>
            <ErrorState title="Your test calls didn't pass" detail={failure} />
            {keysOn && <UpstreamAuthForm apiId={apiId} initial={upstreamAuth} hint={authHint} retriesTests
              v3={env.upstreamAuthV3()} egressIps={env.gatewayEgressIps()} />}
          </>
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

  const [promises, pack, upstreamAuth, suggestedPhrases, exposure] = await Promise.all([
    listLatestRules(sql, apiId), getPack(sql, apiId), getUpstreamAuth(sql, apiId), getSuggestedPhrases(sql, apiId), getStoredExposure(sql, apiId),
  ]);
  const frontDoor = await getFrontDoorSummary(sql, apiId);
  return (
    <section className="space-y-6">
      {heading}
      {overlaps}
      {promises.length === 0 ? (
        <WaitingState title="Writing your promise" detail="The test calls finished; the promise appears here in a moment." />
      ) : (
        <ReviewPanel apiId={apiId} state={api.state} promises={promises} pack={pack} suggestedPhrases={suggestedPhrases} />
      )}
      {/* Publishing needs every endpoint to refuse calls without the key; the publish route runs this check again. */}
      {promises.length > 0 && (
        <ExposureCard apiId={apiId}
          initial={exposure ? { exposure: exposure.exposure, checkedAt: exposure.checkedAt?.toISOString() ?? null } : null} />
      )}
      {/* The key the leak check points to, and key rotation before publishing: a new key takes effect on the next call. */}
      {keysOn && (
        <div id={KEY_FORM_ID}>
          <UpstreamAuthForm apiId={apiId} initial={upstreamAuth} hint={null} title="Your API's key"
            v3={env.upstreamAuthV3()} egressIps={env.gatewayEgressIps()} />
        </div>
      )}
      <ProtectLink apiId={apiId} frontDoor={frontDoor} />
    </section>
  );
}
