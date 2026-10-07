"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { InlineError, InlineStatus } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { deleteJson, postJson, RequestError } from "@/lib/client-fetch";
import { cn } from "@/lib/utils";

type Placement = "header" | "query";
/** Where the stored key goes and its last 4 characters (lib/repo/upstream-auth.ts). Never the key. */
export type UpstreamAuthSetting = { in: Placement; name: string; hint: string };
/** What the OpenAPI file says about the key (the coworker's parse step "authHint"). */
export type UpstreamAuthHint = { in: Placement; name: string; prefix?: string };

const PLACE_LABEL: Record<Placement, string> = { header: "header", query: "query parameter" };
export const QUERY_KEY_WARNING = "A key in the address can leak in logs and error messages. Use a header if your API accepts one.";

/** "X-API-Key in header, ending in WXYZ". Short keys have no hint. */
export function describeSetting(s: UpstreamAuthSetting): string {
  return `${s.name} in ${s.in === "header" ? "header" : "query"}${s.hint ? `, ending in ${s.hint}` : ""}`;
}

/** A Bearer style hint: the prefix goes in front of the key when the seller leaves it out. */
export function withPrefix(value: string, prefix: string | undefined): string {
  const v = value.trim();
  if (!prefix || !v || v.toLowerCase().startsWith(prefix.trim().toLowerCase())) return v;
  return `${prefix}${v}`;
}

type Status = { kind: "idle" } | { kind: "saving" } | { kind: "removing" } | { kind: "error"; text: string } | { kind: "saved"; text: string };

/**
 * The optional key the gateway sends to the seller's API. The key goes to Hirakumi once, is sealed for the
 * gateway, and is never shown again: only where it goes and its last 4 characters come back.
 */
export function UpstreamAuthForm({ apiId, initial, hint, title = "Does your API need a key?", retriesTests = false, notice }: {
  apiId: string;
  initial: UpstreamAuthSetting | null;
  hint: UpstreamAuthHint | null;
  title?: string;
  /** After failed test calls: a saved or removed key runs them again, so the page refreshes to show them. */
  retriesTests?: boolean;
  /** A problem with the stored key the gateway reported (the API's address changed since it was saved, say). */
  notice?: string;
}) {
  const router = useRouter();
  const [current, setCurrent] = useState(initial);
  const [editing, setEditing] = useState(!initial && hint !== null);
  const [place, setPlace] = useState<Placement>(initial?.in ?? hint?.in ?? "header");
  const [name, setName] = useState(initial?.name ?? hint?.name ?? "");
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const busy = status.kind === "saving" || status.kind === "removing";
  // The prefix only applies to the place and name the OpenAPI file gave it for.
  const prefix = hint?.prefix && place === hint.in && name.trim().toLowerCase() === hint.name.toLowerCase() ? hint.prefix : undefined;

  async function save(e: FormEvent) {
    e.preventDefault();
    setStatus({ kind: "saving" });
    try {
      const saved = await postJson<UpstreamAuthSetting>(`/api/apis/${apiId}/upstream-auth`, { in: place, name: name.trim(), value: withPrefix(value, prefix) });
      setCurrent(saved);
      setValue("");
      setEditing(false);
      setStatus({ kind: "saved", text: retriesTests ? "Key saved. The test calls run again now." : "Key saved. Hirakumi sends it with every call to your API." });
      if (retriesTests) router.refresh();
    } catch (err) {
      setStatus({ kind: "error", text: err instanceof RequestError ? err.message : "Something went wrong. Try again." });
    }
  }

  async function remove() {
    setStatus({ kind: "removing" });
    try {
      await deleteJson(`/api/apis/${apiId}/upstream-auth`);
      setCurrent(null);
      setEditing(false);
      setStatus({ kind: "saved", text: retriesTests ? "Key removed. The test calls run again now." : "Key removed. Calls to your API go without a key." });
      if (retriesTests) router.refresh();
    } catch (err) {
      setStatus({ kind: "error", text: err instanceof RequestError ? err.message : "Something went wrong. Try again." });
    }
  }

  const tab = (p: Placement) => (
    <button
      key={p}
      type="button"
      role="radio"
      aria-checked={place === p}
      disabled={busy}
      onClick={() => setPlace(p)}
      className={cn(
        "cursor-pointer rounded-[2px] border-2 border-ink px-3 py-1.5 text-body font-medium transition-colors duration-100",
        place === p ? "bg-ink text-cream" : "bg-frost text-ink",
      )}
    >
      {p === "header" ? "Header" : "Query parameter"}
    </button>
  );

  return (
    <section aria-labelledby={`upstream-auth-${apiId}`} className="space-y-3 rounded-[2px] border-2 border-ink bg-frost p-5">
      <h2 id={`upstream-auth-${apiId}`} className="text-body-lg font-semibold">{title}</h2>
      <p className="text-body">
        If your API only answers with a key, add it here. It is encrypted so only the Hirakumi gateway can read it. It is
        sent only to this API&apos;s own address, and it is never shown again.
      </p>
      {retriesTests && <p className="text-body">When you save or remove the key, the test calls run again.</p>}
      {notice && status.kind !== "saved" && <InlineError>{notice}</InlineError>}
      {hint && !current && (
        <p className="text-caption text-graphite">Your API description asks for a key in the {PLACE_LABEL[hint.in]} {hint.name}.</p>
      )}
      {current && !editing && (
        <div className="flex flex-wrap items-center gap-4">
          <p className="text-body font-medium" data-testid="upstream-auth-current">{describeSetting(current)}</p>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { setEditing(true); setPlace(current.in); setName(current.name); setStatus({ kind: "idle" }); }}>
            Replace
          </Button>
          <Button variant="outline" size="sm" disabled={busy} pending={status.kind === "removing"} pendingLabel="Removing…" onClick={() => void remove()}>
            Remove
          </Button>
        </div>
      )}
      {!current && !editing && (
        <Button variant="outline" onClick={() => { setEditing(true); setStatus({ kind: "idle" }); }}>Add a key</Button>
      )}
      {editing && (
        <form onSubmit={save} aria-busy={busy || undefined} className="space-y-4">
          <div role="radiogroup" aria-label="Where the key goes" className="flex flex-wrap gap-2">
            {tab("header")}
            {tab("query")}
          </div>
          {place === "query" && <p className="text-body" role="note" data-testid="query-key-warning">{QUERY_KEY_WARNING}</p>}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label htmlFor={`upstream-auth-name-${apiId}`} className="block text-body font-medium">
                {place === "header" ? "Header name" : "Query parameter name"}
              </label>
              <Input id={`upstream-auth-name-${apiId}`} type="text" autoComplete="off" spellCheck={false}
                placeholder={place === "header" ? "X-API-Key" : "api_key"} value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
            </div>
            <div className="space-y-2">
              <label htmlFor={`upstream-auth-value-${apiId}`} className="block text-body font-medium">Key</label>
              <Input id={`upstream-auth-value-${apiId}`} type="password" autoComplete="off" spellCheck={false}
                placeholder={prefix ? `${prefix}...` : "Paste the key"} value={value} onChange={(e) => setValue(e.target.value)} disabled={busy} />
            </div>
          </div>
          {prefix && <p className="text-caption text-graphite">We add &quot;{prefix.trim()}&quot; in front of the key if you leave it out.</p>}
          <div className="flex flex-wrap items-center gap-4">
            <Button type="submit" disabled={busy || !name.trim() || !value.trim()} pending={status.kind === "saving"} pendingLabel="Saving…">
              {current ? "Save the new key" : "Save key"}
            </Button>
            {(current || !hint) && (
              <Button type="button" variant="outline" disabled={busy} onClick={() => { setEditing(false); setValue(""); setStatus({ kind: "idle" }); }}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      )}
      {status.kind === "saved" && <InlineStatus>{status.text}</InlineStatus>}
      {status.kind === "error" && <InlineError>{status.text}</InlineError>}
    </section>
  );
}
