import { ViewTransition, type ReactNode } from "react";
import { ApiNav } from "@/components/api-nav";
import { getSql } from "@/lib/db";
import { readPageSession } from "@/lib/page-auth";
import { getApiForSeller } from "@/lib/repo/apis";
import { loadProgress } from "@/lib/repo/progress";

/**
 * The page for the API's current step, so the "Listing steps" tab never goes through the redirect. Pages enforce
 * sign-in and ownership themselves; without either, the tab keeps the redirecting link.
 */
async function loadStepHref(apiId: string): Promise<string> {
  const session = await readPageSession();
  const sql = getSql();
  const api = session ? await getApiForSeller(sql, apiId, session.sellerId) : null;
  return api ? (await loadProgress(sql, api)).href : `/apis/${apiId}`;
}

export default async function ApiLayout({ children, params }: { children: ReactNode; params: Promise<{ apiId: string }> }) {
  const { apiId } = await params;
  const stepHref = await loadStepHref(apiId);
  return (
    // min-w-0 keeps wide code blocks scrolling inside the page instead of widening it.
    <div className="min-w-0 space-y-6">
      <ApiNav apiId={apiId} stepHref={stepHref} />
      {/* Moving to the next step crossfades the step card (globals.css, .step-card). */}
      <ViewTransition name="api-step" default="step-card">
        <div>{children}</div>
      </ViewTransition>
    </div>
  );
}
