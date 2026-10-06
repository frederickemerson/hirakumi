"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Elapsed } from "@/components/elapsed";
import { InlineError, InlineStatus } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { postJson, RequestError } from "@/lib/client-fetch";
import { startRouteProgress } from "@/lib/route-progress";

export function SetupForm({ initialUrl, setupToken }: { initialUrl: string; setupToken?: string }) {
  const router = useRouter();
  const [url, setUrl] = useState(initialUrl);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const data = await postJson<{ apiId: string }>("/api/apis", { openapiUrl: url, name, ...(setupToken ? { setupToken } : {}) });
      startRouteProgress();
      router.push(`/apis/${data.apiId}/endpoints`);
    } catch (err) {
      setError(err instanceof RequestError ? err.message : "Something went wrong. Try again.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} aria-busy={busy || undefined} className="space-y-5 rounded-[2px] border-2 border-ink bg-frost p-6 sm:p-8">
      <div className="space-y-2">
        <label htmlFor="openapi-url" className="block text-body font-medium">OpenAPI link</label>
        <Input id="openapi-url" type="text" inputMode="url" placeholder="https://example.com/openapi.json"
          value={url} onChange={(e) => setUrl(e.target.value)} disabled={busy} />
        <p className="text-caption text-graphite">An https link to an OpenAPI 3 file, JSON or YAML.</p>
      </div>
      <div className="space-y-2">
        <label htmlFor="api-name" className="block text-body font-medium">Name (optional)</label>
        <Input id="api-name" type="text" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
      </div>
      {error && <InlineError>{error}</InlineError>}
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" pending={busy} pendingLabel="Checking your link…">Continue</Button>
        {busy && (
          <InlineStatus busy>
            Reading your OpenAPI file <Elapsed prefix=" " className="text-graphite" />
          </InlineStatus>
        )}
      </div>
    </form>
  );
}
