"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { postJson, RequestError } from "@/lib/client-fetch";

export function RetireButton({ apiId }: { apiId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  async function retire() {
    if (!window.confirm("Remove this API from the agent market? New sales stop. This can't be undone.")) return;
    try {
      await postJson(`/api/apis/${apiId}/retire`, {});
      router.refresh();
    } catch (e) {
      setError(e instanceof RequestError ? e.message : "Something went wrong. Try again.");
    }
  }
  return (
    <div className="space-y-1">
      <Button variant="destructive" onClick={retire}>Remove from the market</Button>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
