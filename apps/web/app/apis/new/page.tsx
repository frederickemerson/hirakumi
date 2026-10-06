import { SellerGuide } from "@/components/seller-guide";
import { SetupForm } from "@/components/setup-form";
import { env } from "@/lib/env";
import { requireSellerPage } from "@/lib/page-auth";

export default async function NewApiPage({ searchParams }: { searchParams: Promise<{ openapiUrl?: string }> }) {
  await requireSellerPage("/apis/new");
  const { openapiUrl } = await searchParams;
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
      <section className="min-w-0 max-w-xl space-y-6">
        <h1 className="text-h font-medium uppercase">Put your API on the agent market</h1>
        <p className="text-body-lg">
          Paste the link to your OpenAPI 3 description. Hirakumi reads it and lists the endpoints it could sell.
          Nothing is published until you approve it.
        </p>
        <SetupForm initialUrl={typeof openapiUrl === "string" ? openapiUrl : ""} />
      </section>
      <SellerGuide apiId={null} initial={null} chatEnabled={env.chatFallback()} />
    </div>
  );
}
