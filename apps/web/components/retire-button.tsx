"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { InlineError } from "@/components/states";
import { Button } from "@/components/ui/button";
import { postJson, RequestError } from "@/lib/client-fetch";

export function RetireButton({ apiId }: { apiId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function retire() {
    if (!window.confirm("Remove this API from the agent market? New sales stop. This can't be undone.")) return;
    setBusy(true);
    setError(null);
    try {
      await postJson(`/api/apis/${apiId}/retire`, {});
      router.refresh();
    } catch (e) {
      setError(e instanceof RequestError ? e.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2 border-t border-ink pt-6">
      <Button variant="destructive" pending={busy} pendingLabel="Removing…" onClick={retire}>Remove from the market</Button>
      {error && <InlineError>{error}</InlineError>}
    </div>
  );
}
