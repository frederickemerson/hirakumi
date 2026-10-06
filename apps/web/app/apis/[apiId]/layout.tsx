import { cookies } from "next/headers";
import { ViewTransition, type ReactNode } from "react";
import { ApiNav } from "@/components/api-nav";
import { ChatPanel } from "@/components/chat-panel";
import { getSql } from "@/lib/db";
import { env } from "@/lib/env";
import { stepForState } from "@/lib/flow";
import { getApiForSeller } from "@/lib/repo/apis";
import { readSessionToken, SESSION_COOKIE } from "@/lib/session";

/** The page for the API's current step, so the "Listing steps" tab never goes through the redirect. */
async function currentStepHref(apiId: string): Promise<string> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = token ? readSessionToken(token) : null;
  // Pages enforce sign-in and ownership themselves; without either the tab keeps the redirecting link.
  const api = session ? await getApiForSeller(getSql(), apiId, session.sellerId) : null;
  return api ? `/apis/${apiId}/${stepForState(api.state)}` : `/apis/${apiId}`;
}

export default async function ApiLayout({ children, params }: { children: ReactNode; params: Promise<{ apiId: string }> }) {
  const { apiId } = await params;
  const chat = env.chatFallback();
  const stepHref = await currentStepHref(apiId);
  return (
    <div className={chat ? "grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]" : ""}>
      {/* min-w-0 keeps wide code blocks scrolling inside the column instead of widening the page. */}
      <div className="min-w-0 space-y-6">
        <ApiNav apiId={apiId} stepHref={stepHref} />
        {/* Moving to the next step crossfades the step card (globals.css, .step-card). */}
        <ViewTransition name="api-step" default="step-card">
          <div>{children}</div>
        </ViewTransition>
      </div>
      {chat && <aside className="min-w-0"><ChatPanel apiId={apiId} /></aside>}
    </div>
  );
}
