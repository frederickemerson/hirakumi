import type { Metadata } from "next";
import { ActPanel, type ActKeyHint } from "@/components/act-panel";
import { ErrorState } from "@/components/states";
import { actKeyHint, actTitle, openAct, walletTail } from "@/lib/act";
import { getSql } from "@/lib/db";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign", robots: { index: false, follow: false } };

/**
 * A one-time link from a Sokosumi comment: one wallet step on one page, with no site around it. The seller signs
 * and closes the tab; the coworker posts the next step in the task.
 */
export default async function ActPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const sql = getSql();
  const opened = await openAct(sql, token);
  if (!opened.ok) {
    return (
      <section className="mx-auto max-w-lg">
        <ErrorState title="This link can't be used" detail={opened.error} />
      </section>
    );
  }
  const hint = await actKeyHint(sql, opened);
  const keyHint: ActKeyHint | null = hint ? { in: hint.in, name: hint.name, ...(hint.prefix ? { prefix: hint.prefix } : {}) } : null;
  return (
    <section className="mx-auto max-w-lg">
      <ActPanel token={token} action={opened.act.action} title={await actTitle(sql, opened)} wallet={walletTail(opened.owner.addr)} keyHint={keyHint} />
    </section>
  );
}
