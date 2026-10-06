import type { ReactNode } from "react";
import { ApiNav } from "@/components/api-nav";
import { ChatPanel } from "@/components/chat-panel";
import { env } from "@/lib/env";

export default async function ApiLayout({ children, params }: { children: ReactNode; params: Promise<{ apiId: string }> }) {
  const { apiId } = await params;
  const chat = env.chatFallback();
  return (
    <div className={chat ? "grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]" : ""}>
      {/* min-w-0 keeps wide code blocks scrolling inside the column instead of widening the page. */}
      <div className="min-w-0 space-y-6">
        <ApiNav apiId={apiId} />
        {children}
      </div>
      {chat && <aside className="min-w-0"><ChatPanel apiId={apiId} /></aside>}
    </div>
  );
}
