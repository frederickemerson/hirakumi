"use client";

import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { toast } from "@/components/toast";
import { postJson } from "@/lib/client-fetch";
import { RETIRE_COPY } from "@/lib/copy";

export function RetireButton({ apiId, name }: { apiId: string; name: string }) {
  const router = useRouter();
  async function retire() {
    await postJson(`/api/apis/${apiId}/retire`, {});
    toast(`Retired ${name}`);
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
        confirmLabel={RETIRE_COPY.confirm}
        pendingLabel={RETIRE_COPY.pending}
        onConfirm={retire}
      />
    </div>
  );
}
