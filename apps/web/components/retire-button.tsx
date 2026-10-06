"use client";

import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { toast } from "@/components/toast";
import { postJson } from "@/lib/client-fetch";

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
        triggerLabel="Remove from the market"
        triggerVariant="destructive"
        triggerSize="default"
        title={`Retire ${name}?`}
        description="New sales stop and the API leaves the agent market. This can't be undone."
        confirmLabel="Retire API"
        pendingLabel="Retiring…"
        onConfirm={retire}
      />
    </div>
  );
}
