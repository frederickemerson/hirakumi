import { SetupForm } from "@/components/setup-form";
import { InlineError } from "@/components/states";
import { requireSellerPage } from "@/lib/page-auth";

/** Entry point from the Sokosumi coworker's comment: /setup?t=<setup_token> (contract W1). */
export default async function SokosumiSetupPage({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  const { t } = await searchParams;
  const token = typeof t === "string" ? t : "";
  await requireSellerPage(`/setup?t=${encodeURIComponent(token)}`);
  return (
    <section className="max-w-xl space-y-6">
      <h1 className="text-h font-medium uppercase">Put your API on the agent market</h1>
      <p className="text-body-lg">
        You came here from your Sokosumi task. Paste the link to your OpenAPI 3 description. Hirakumi posts every step
        back to that task, and nothing is published until you approve it.
      </p>
      {token ? (
        <SetupForm initialUrl="" setupToken={token} />
      ) : (
        <InlineError>This setup link is missing its code. Open the link from your Sokosumi task again.</InlineError>
      )}
    </section>
  );
}
