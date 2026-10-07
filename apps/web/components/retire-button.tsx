"use client";

import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { toast } from "@/components/toast";
import { postJson } from "@/lib/client-fetch";
import { RETIRE_COPY } from "@/lib/copy";

/**
 * Retire: the whole monetization layer goes (sales, the key, the front door). `undo` lists what the seller then
 * undoes on their side; it is shown before they confirm and kept in their chat afterwards.
 */
export function RetireButton({ apiId, name, undo = [] }: { apiId: string; name: string; undo?: string[] }) {
  const router = useRouter();
  async function retire() {
    const r = await postJson<{ undo?: string[] }>(`/api/apis/${apiId}/retire`, {});
    toast(r.undo?.length ? `Retired ${name}. The steps to undo on your side are in your messages.` : `Retired ${name}`);
    router.refresh();
  }
  return (
    <div className="border-t border-ink pt-6">
      <ConfirmDialog
        triggerLabel={RETIRE_COPY.trigger}
        triggerVariant="destructive"
        triggerSize="default"
        title={RETIRE_COPY.title(name)}
        description={RETIRE_COPY.description}
        details={undo.length ? (
          <div className="space-y-1 text-body">
            <p className="font-medium">Then, on your side:</p>
            <ol className="list-decimal space-y-1 pl-5 text-graphite">{undo.map((s) => <li key={s}>{s}</li>)}</ol>
          </div>
        ) : undefined}
        confirmLabel={RETIRE_COPY.confirm}
        pendingLabel={RETIRE_COPY.pending}
        onConfirm={retire}
      />
    </div>
  );
}
