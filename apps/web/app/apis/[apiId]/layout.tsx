import type { Metadata } from "next";
import { cache, ViewTransition, type ReactNode } from "react";
import { ApiNav } from "@/components/api-nav";
import { getSql } from "@/lib/db";
import { readPageSession } from "@/lib/page-auth";
import { getApiForSeller } from "@/lib/repo/apis";
import { loadProgress } from "@/lib/repo/progress";

/** The signed-in seller's own API, or null. Pages enforce sign-in and ownership themselves. */
const loadOwnApi = cache(async (apiId: string) => {
  const session = await readPageSession();
  return session ? getApiForSeller(getSql(), apiId, session.sellerId) : null;
});

/** Each page titles itself ("Sales"); the API's name follows, so tabs and history tell APIs apart. */
export async function generateMetadata({ params }: { params: Promise<{ apiId: string }> }): Promise<Metadata> {
  const api = await loadOwnApi((await params).apiId);
  return api ? { title: { template: `%s | ${api.name} | Hirakumi`, default: api.name } } : {};
}

/**
 * The page for the API's current step, so the "Listing steps" tab never goes through the redirect. Without a
 * session or ownership, the tab keeps the redirecting link. Once the API is live or retired the steps are
 * over and the tab would only repeat Overview, so it is hidden.
 */
async function loadSteps(apiId: string): Promise<string | null> {
  const api = await loadOwnApi(apiId);
  if (!api) return `/apis/${apiId}`;
  if (api.state === "live" || api.state === "retired") return null;
  return (await loadProgress(getSql(), api)).href;
}

export default async function ApiLayout({ children, params }: { children: ReactNode; params: Promise<{ apiId: string }> }) {
  const { apiId } = await params;
  const stepHref = await loadSteps(apiId);
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
