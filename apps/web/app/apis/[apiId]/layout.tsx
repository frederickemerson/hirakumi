import { cookies } from "next/headers";
import { ViewTransition, type ReactNode } from "react";
import { ApiNav } from "@/components/api-nav";
import { SellerGuide } from "@/components/seller-guide";
import { getSql } from "@/lib/db";
import { env } from "@/lib/env";
import type { ApiProgress } from "@/lib/progress";
import { getApiForSeller } from "@/lib/repo/apis";
import { loadProgress } from "@/lib/repo/progress";
import { readSessionToken, SESSION_COOKIE } from "@/lib/session";

/**
 * The signed-in seller's progress on this API, or null. Pages enforce sign-in and ownership
 * themselves; without either, the tab keeps the redirecting link and the guide shows nothing specific.
 */
async function loadSellerProgress(apiId: string): Promise<ApiProgress | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = token ? readSessionToken(token) : null;
  const sql = getSql();
  const api = session ? await getApiForSeller(sql, apiId, session.sellerId) : null;
  return api ? loadProgress(sql, api) : null;
}

export default async function ApiLayout({ children, params }: { children: ReactNode; params: Promise<{ apiId: string }> }) {
  const { apiId } = await params;
  const progress = await loadSellerProgress(apiId);
  // The page for the API's current step, so the "Listing steps" tab never goes through the redirect.
  const stepHref = progress?.href ?? `/apis/${apiId}`;
  return (
    // The guide's column is part of the grid from the first paint, so nothing moves when it hydrates.
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
      {/* min-w-0 keeps wide code blocks scrolling inside the column instead of widening the page. */}
      <div className="min-w-0 space-y-6">
        <ApiNav apiId={apiId} stepHref={stepHref} />
        {/* Moving to the next step crossfades the step card (globals.css, .step-card). */}
        <ViewTransition name="api-step" default="step-card">
          <div>{children}</div>
        </ViewTransition>
      </div>
      {progress && <SellerGuide apiId={apiId} initial={progress} chatEnabled={env.chatFallback()} />}
    </div>
  );
}
