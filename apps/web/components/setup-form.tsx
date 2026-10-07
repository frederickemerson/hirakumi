"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Elapsed } from "@/components/elapsed";
import { InlineError, InlineStatus } from "@/components/states";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { postJson, RequestError } from "@/lib/client-fetch";
import { startRouteProgress } from "@/lib/route-progress";
import { cn } from "@/lib/utils";

type Mode = "openapi" | "samples";

const SAMPLES_PLACEHOLDER = "GET /price?symbol=ADA\nGET /coins/{id=cardano}?vs=usd&days?=7\nPOST /search {\"q\": \"ada\"}";

/** samples: offer the "I don't" option (example requests); off until SAMPLES_INTAKE is on (lib/repo/schema.ts). */
export function SetupForm({ initialUrl, setupToken, samples: samplesOn = false }: { initialUrl: string; setupToken?: string; samples?: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("openapi");
  const [url, setUrl] = useState(initialUrl);
  const [baseUrl, setBaseUrl] = useState("");
  const [samples, setSamples] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Example requests that may hold a key: the API is listed, and the seller reads these before going on.
  const [warned, setWarned] = useState<{ apiId: string; warnings: string[] } | null>(null);
  // The seller already listed this API: say so, instead of jumping to it.
  const [duplicate, setDuplicate] = useState<{ apiId: string; state: string; name: string } | null>(null);

  function openEndpoints(apiId: string) {
    startRouteProgress();
    router.push(`/apis/${apiId}/endpoints`);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDuplicate(null);
    try {
      const intake = mode === "openapi" ? { openapiUrl: url } : { mode: "samples", baseUrl, samples };
      const data = await postJson<{ apiId: string; state: string; name: string; created: boolean; keyWarnings?: string[] }>(
        "/api/apis", { ...intake, name, ...(setupToken ? { setupToken } : {}) });
      if (data.created === false) {
        setDuplicate({ apiId: data.apiId, state: data.state, name: data.name });
        setBusy(false);
        return;
      }
      if (data.keyWarnings?.length) {
        setWarned({ apiId: data.apiId, warnings: data.keyWarnings });
        setBusy(false);
        return;
      }
      openEndpoints(data.apiId);
    } catch (err) {
      setError(err instanceof RequestError ? err.message : "Something went wrong. Try again.");
      setBusy(false);
    }
  }

  const tab = (m: Mode, label: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={mode === m}
      disabled={busy}
      onClick={() => { setMode(m); setError(null); }}
      className={cn(
        "cursor-pointer rounded-[2px] border-2 border-ink px-3 py-1.5 text-body font-medium transition-colors duration-100",
        mode === m ? "bg-ink text-cream" : "bg-frost text-ink",
      )}
    >
      {label}
    </button>
  );

  return (
    <form onSubmit={submit} aria-busy={busy || undefined} className="space-y-5 rounded-[2px] border-2 border-ink bg-frost p-6 sm:p-8">
      {samplesOn && (
        <div role="radiogroup" aria-label="How to describe your API" className="flex flex-wrap gap-2">
          {tab("openapi", "I have an OpenAPI file")}
          {tab("samples", "I don't")}
        </div>
      )}
      {mode === "openapi" || !samplesOn ? (
        <div className="space-y-2">
          <label htmlFor="openapi-url" className="block text-body font-medium">OpenAPI link</label>
          <Input id="openapi-url" type="text" inputMode="url" placeholder="https://example.com/openapi.json"
            value={url} onChange={(e) => setUrl(e.target.value)} disabled={busy} />
          <p className="text-caption text-graphite">
            An https link to an OpenAPI 3 file, JSON or YAML. It can be hosted anywhere, GitHub too. If it isn&apos;t on your API&apos;s host, its first servers entry must be your API&apos;s full URL.
          </p>
        </div>
      ) : (
        <>
          <div className="space-y-2">
            <label htmlFor="base-url" className="block text-body font-medium">Base URL</label>
            <Input id="base-url" type="text" inputMode="url" placeholder="https://api.example.com/v1"
              value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} disabled={busy} />
            <p className="text-caption text-graphite">Where your API runs. Every endpoint is under this folder.</p>
          </div>
          <div className="space-y-2">
            <label htmlFor="samples" className="block text-body font-medium">Example requests</label>
            <textarea id="samples" rows={5} spellCheck={false} placeholder={SAMPLES_PLACEHOLDER}
              value={samples} onChange={(e) => setSamples(e.target.value)} disabled={busy}
              className="w-full min-w-0 rounded-[2px] border-2 border-ink bg-frost px-3 py-2 font-mono text-caption text-ink outline-none placeholder:text-pencil focus-visible:border-sky disabled:cursor-not-allowed disabled:border-pencil disabled:bg-chalk" />
            <ul className="list-disc space-y-0.5 pl-5 text-caption text-graphite">
              <li>One request per line, with real values. We use them for the test calls.</li>
              <li><code>{"{id=cardano}"}</code> marks a path parameter. <code>days?=7</code> marks an optional query parameter.</li>
              <li>A JSON body goes after the path. The method is GET if you leave it out.</li>
              <li>Leave out your API key. Buyers see these values. You add the key later on the ownership step, where only the Hirakumi gateway can read it.</li>
            </ul>
          </div>
        </>
      )}
      <div className="space-y-2">
        <label htmlFor="api-name" className="block text-body font-medium">Name (optional)</label>
        <Input id="api-name" type="text" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
      </div>
      {error && <InlineError>{error}</InlineError>}
      {duplicate && <AlreadyListed {...duplicate} onContinue={() => openEndpoints(duplicate.apiId)} />}
      {warned ? (
        <div className="space-y-3" data-testid="key-warnings">
          <ul className="list-disc space-y-1 pl-5 text-body">
            {warned.warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
          <p className="text-body text-graphite">
            If one of these is your API&apos;s key, issue a new key: these lines are saved, and buyers will see them. Hirakumi won&apos;t accept a key that appears in them.
          </p>
          <Button type="button" onClick={() => openEndpoints(warned.apiId)}>Continue to endpoints</Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-4">
          <Button type="submit" pending={busy} pendingLabel={mode === "openapi" ? "Checking your link…" : "Checking your requests…"}>Continue</Button>
          {busy && (
            <InlineStatus busy>
              {mode === "openapi" ? "Reading your OpenAPI file" : "Reading your example requests"} <Elapsed prefix=" " className="text-graphite" />
            </InlineStatus>
          )}
        </div>
      )}
    </form>
  );
}

/** The seller pasted an API they already listed: live means it is already monetized, otherwise they can pick up where they left off. */
function AlreadyListed({ apiId, state, name, onContinue }: { apiId: string; state: string; name: string; onContinue: () => void }) {
  const live = state === "live" || state === "registering";
  return (
    <div role="alert" data-testid="already-listed" className="space-y-3 rounded-[2px] border-2 border-ink border-l-8 border-l-canary bg-frost p-4 text-body">
      {live ? (
        <>
          <p className="font-semibold">This API is already monetized on Hirakumi.</p>
          <p>You listed it as {name}. Agents already buy it there, so it can&apos;t be listed twice.</p>
          <div className="flex flex-wrap gap-3">
            <a href={`/apis/${apiId}/overview`} className={buttonVariants({ size: "sm" })}>Open {name}</a>
            <a href={`/p/${apiId}`} className={buttonVariants({ variant: "outline", size: "sm" })}>Its public page</a>
          </div>
        </>
      ) : (
        <>
          <p className="font-semibold">You already started listing this API.</p>
          <p>It is saved as {name}. Pick up where you left off.</p>
          <Button type="button" size="sm" onClick={onContinue}>Continue listing {name}</Button>
        </>
      )}
    </div>
  );
}
