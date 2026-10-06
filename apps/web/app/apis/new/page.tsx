import { ChatPanel } from "@/components/chat-panel";
import { SetupForm } from "@/components/setup-form";
import { env } from "@/lib/env";
import { requireSellerPage } from "@/lib/page-auth";

export default async function NewApiPage({ searchParams }: { searchParams: Promise<{ openapiUrl?: string }> }) {
  await requireSellerPage("/apis/new");
  const { openapiUrl } = await searchParams;
  return (
    <section className="max-w-xl space-y-6">
      <h1 className="text-2xl font-semibold">Put your API on the agent market</h1>
      <p className="text-muted-foreground">
        Paste the link to your OpenAPI 3 description. Hirakumi reads it and lists the endpoints it could sell.
        Nothing is published until you approve it.
      </p>
      <SetupForm initialUrl={typeof openapiUrl === "string" ? openapiUrl : ""} />
      {env.chatFallback() && <ChatPanel apiId={null} />}
    </section>
  );
}
