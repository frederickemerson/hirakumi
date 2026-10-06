"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { postJson, RequestError } from "@/lib/client-fetch";

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
      router.push(`/apis/${data.apiId}/endpoints`);
    } catch (err) {
      setError(err instanceof RequestError ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-2">
        <label htmlFor="openapi-url" className="text-sm font-medium">OpenAPI link</label>
        <Input id="openapi-url" type="text" inputMode="url" placeholder="https://example.com/openapi.json"
          value={url} onChange={(e) => setUrl(e.target.value)} />
      </div>
      <div className="space-y-2">
        <label htmlFor="api-name" className="text-sm font-medium">Name (optional)</label>
        <Input id="api-name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Continue"}</Button>
    </form>
  );
}
