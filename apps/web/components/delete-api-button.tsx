"use client";

import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { toast } from "@/components/toast";
import { deleteJson } from "@/lib/client-fetch";
import type { ApiState } from "@/lib/types";

const ERASED = ["The API and its endpoints", "Promises, test inputs and test calls", "Prices, ownership checks and progress", "Chat messages about it"];

/** What deleting does, in the seller's words: erased outright, or taken off the market with its records kept. */
export function deleteCopy(state: ApiState, recordsKept: string | null): { description: string; details: string[] } {
  if (recordsKept === null) {
    return { description: "Nothing on Masumi points at it and nobody paid for it, so it's erased. This can't be undone.", details: ERASED };
  }
  return {
    description: `${recordsKept} It disappears from your account. This can't be undone.`,
    details: [
      state === "live" ? "Buyers can't buy packs or hire it any more" : "Its listing stops and it never goes on the market",
      "Buyers' receipts and any escrow payments stay on record and still settle",
      "Its Masumi registry entry stays, pointing at an API that answers 404",
    ],
  };
}

type DeletableApi = { id: string; name: string; state: ApiState; recordsKept: string | null };

/** For a server-rendered list: refreshes the page once the API is deleted, so its row drops. */
export function RefreshingDeleteApiButton({ api }: { api: DeletableApi }) {
  const router = useRouter();
  return <DeleteApiButton api={api} onDeleted={() => router.refresh()} />;
}

/** Delete at any stage, behind a type-the-name confirmation. `onDeleted` runs after the server confirms. */
export function DeleteApiButton({ api, onDeleted }: { api: DeletableApi; onDeleted: () => void }) {
  const copy = deleteCopy(api.state, api.recordsKept);
  return (
    <ConfirmDialog
      triggerLabel="Delete"
      triggerVariant="destructive"
      title={`Delete ${api.name}?`}
      description={copy.description}
      details={
        <ul className="list-disc space-y-1 pl-5 text-body text-graphite">
          {copy.details.map((d) => <li key={d}>{d}</li>)}
        </ul>
      }
      confirmLabel="Delete API"
      pendingLabel="Deleting…"
      typeToConfirm={api.name}
      onConfirm={async () => {
        await deleteJson(`/api/apis/${api.id}`);
        toast(`Deleted ${api.name}`);
        onDeleted();
      }}
    />
  );
}
