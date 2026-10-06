import type { ReactNode } from "react";
import { ApiNav } from "@/components/api-nav";
import { ChatPanel } from "@/components/chat-panel";
import { env } from "@/lib/env";

export default async function ApiLayout({ children, params }: { children: ReactNode; params: Promise<{ apiId: string }> }) {
  const { apiId } = await params;
  const chat = env.chatFallback();
  return (
    <div className={chat ? "grid gap-8 lg:grid-cols-[1fr_320px]" : ""}>
      <div className="space-y-6">
        <ApiNav apiId={apiId} />
        {children}
      </div>
      {chat && <aside><ChatPanel apiId={apiId} /></aside>}
    </div>
  );
}
