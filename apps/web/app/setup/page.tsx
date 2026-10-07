import { SetupForm } from "@/components/setup-form";
import { MoveSokosumiPanel, SokosumiLinkConflict, SokosumiLinkedHere, SokosumiLinkNotice } from "@/components/sokosumi-link";
import { getSql } from "@/lib/db";
import { samplesIntakeOpen } from "@/lib/repo/schema";
import { sokosumiLinkForToken } from "@/lib/repo/sokosumi-link";
import { InlineError } from "@/components/states";
import { requireSellerPage } from "@/lib/page-auth";

const BAD_LINK = "This setup link isn't valid any more. Open the latest link from your Sokosumi task.";

/**
 * Entry point from the Sokosumi coworker's comment: /setup?t=<setup_token> (contract W1). With &link=1 (the
 * coworker's "link wallet" reply) it only links the Sokosumi account to this wallet, without the API form.
 */
export default async function SokosumiSetupPage({ searchParams }: { searchParams: Promise<{ t?: string; link?: string }> }) {
  const { t, link } = await searchParams;
  const token = typeof t === "string" ? t : "";
  const linkOnly = link === "1";
  const session = await requireSellerPage(`/setup?t=${encodeURIComponent(token)}${linkOnly ? "&link=1" : ""}`);
  if (!token) {
    return (
      <Shell linkOnly={linkOnly}>
        <InlineError>This setup link is missing its code. Open the link from your Sokosumi task again.</InlineError>
      </Shell>
    );
  }
  const state = await sokosumiLinkForToken(getSql(), token, session.sellerId);
  if (!state) return <Shell linkOnly={linkOnly}><InlineError>{BAD_LINK}</InlineError></Shell>;
  if (state.status === "conflict") return <Shell linkOnly={linkOnly}><SokosumiLinkConflict /></Shell>;
  if (state.status === "elsewhere") {
    return <Shell linkOnly={linkOnly}><MoveSokosumiPanel setupToken={token} from={state.address} to={session.addr} /></Shell>;
  }
  if (linkOnly) {
    return (
      <Shell linkOnly>
        {state.status === "here"
          ? <SokosumiLinkedHere address={session.addr} />
          : <MoveSokosumiPanel setupToken={token} from={null} to={session.addr} />}
      </Shell>
    );
  }
  return (
    <Shell linkOnly={false}>
      {state.status === "here" ? <SokosumiLinkedHere address={session.addr} /> : <SokosumiLinkNotice address={session.addr} />}
      <SetupForm initialUrl="" setupToken={token} samples={await samplesIntakeOpen(getSql())} />
    </Shell>
  );
}

function Shell({ linkOnly, children }: { linkOnly: boolean; children: React.ReactNode }) {
  return (
    <section className="max-w-xl space-y-6">
      {linkOnly ? (
        <h1 className="text-h font-medium uppercase">Link your Sokosumi account</h1>
      ) : (
        <>
          <h1 className="text-h font-medium uppercase">Put your API on the agent market</h1>
          <p className="text-body-lg">
            You came here from your Sokosumi task. Paste the link to your OpenAPI 3 description. Hirakumi posts every step
            back to that task, and nothing is published until you approve it.
          </p>
        </>
      )}
      {children}
    </section>
  );
}
