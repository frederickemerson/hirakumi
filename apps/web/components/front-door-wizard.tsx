"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { RecordField, ResultCard, StepHead, useDnsSetup, WhereToAdd } from "@/components/ownership-panel";
import { InlineError } from "@/components/states";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { deleteJson, postJson, RequestError } from "@/lib/client-fetch";
import type { DnsSetup } from "@/lib/dns-provider";
import { DOMAIN_STATUS_LABEL, frontDoorRecord } from "@/lib/front-door";
import type { DnsTarget, DomainCheck, DomainStatus, OriginTest } from "@/lib/gateway";
import { cn } from "@/lib/utils";

type Placement = "header" | "query";

export type FrontDoorWizardProps = {
  apiId: string;
  /** The hostname callers use today, which will point at Hirakumi. */
  publicHost: string;
  /** Where Hirakumi calls the API now. */
  origin: string;
  /** The API's proven ownership code: the TXT value at _hirakumi.<new origin host> too. Null when there is none. */
  code: string | null;
  /** The front door's state once the origin moved; null before. */
  domain: { status: DomainStatus; lastError: string | null } | null;
  dnsTarget: DnsTarget | null;
  /** True when the public host is a registrable domain itself (example.com): no CNAME there, an A record instead. */
  apex: boolean;
  /** Where the stored key goes, to prefill the form. The key itself is never sent to the page. */
  keyHint: { in: Placement; name: string } | null;
  /**
   * A stored key in several parts (hks3): where each part goes and whether it is fixed text. The key is sealed for
   * the API's address, so the new origin needs every part typed again. Null for a single key or none.
   */
  keyParts?: KeyPart[] | null;
  /** Where the public host's DNS is managed (probe-dns.ts), streamed in. */
  dns?: Promise<DnsSetup>;
};

type OriginFailure = { text: string; tests?: OriginTest[] };
export type KeyPart = { in: Placement; name: string; fixed?: boolean };

/**
 * The key for the new origin as the server takes it (lib/upstream-key.ts renderKeyBody). A stored bag of one part is
 * HTTP Basic with a password; of several parts, the preset its parts fit: fixed text, a query part, or two headers.
 */
export function partsKeyBody(parts: readonly KeyPart[], values: readonly string[]): Record<string, unknown> {
  if (parts.length === 1) return { preset: "basic", fields: { username: (values[0] ?? "").trim(), password: (values[1] ?? "").trim() } };
  const preset = parts.some((x) => x.fixed) ? "keyPlusFixed" : parts.some((x) => x.in === "query") ? "headerPlusQuery" : "twoHeaders";
  return { preset, fields: { rows: parts.map((x, i) => ({ in: x.in, name: x.name, value: (values[i] ?? "").trim(), fixed: !!x.fixed })) } };
}

/** The new hostname from what the seller typed, or null while it isn't a URL yet. */
function hostOf(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    return u.protocol === "https:" && u.hostname.includes(".") ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * The Hirakumi front door, step by step: the API at a second hostname with its key, then the public hostname
 * pointed at Hirakumi, then a check. Until the last step nothing changes for the API's callers.
 */
export function FrontDoorWizard(p: FrontDoorWizardProps) {
  const router = useRouter();
  const attached = p.domain !== null;
  const [originText, setOriginText] = useState(attached ? p.origin : "");
  const [place, setPlace] = useState<Placement>(p.keyHint?.in ?? "header");
  const [keyName, setKeyName] = useState(p.keyHint?.name ?? "");
  const [keyValue, setKeyValue] = useState("");
  const bag = p.keyParts && p.keyParts.length > 0 ? p.keyParts : null;
  // A one-part bag is Basic: a user name and a password. Otherwise one value per part.
  const [partValues, setPartValues] = useState<string[]>(() => (bag ? (bag.length === 1 ? ["", ""] : bag.map(() => "")) : []));
  const keyReady = bag ? partValues.every((v) => v.trim()) : !!keyName.trim() && !!keyValue.trim();
  const [switching, setSwitching] = useState(false);
  const [failure, setFailure] = useState<OriginFailure | null>(null);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<DomainCheck | { error: string } | null>(null);
  const setup = useDnsSetup(p.dns);
  const newHost = hostOf(originText);
  const record = p.dnsTarget ? frontDoorRecord(p.publicHost, p.dnsTarget, p.apex) : null;
  const connected = p.domain?.status === "active" || (check !== null && "ok" in check && check.ok);

  async function switchOrigin(e: FormEvent) {
    e.preventDefault();
    setSwitching(true);
    setFailure(null);
    try {
      const res = await fetch(`/api/apis/${p.apiId}/front-door/origin`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          origin: originText.trim(),
          key: bag ? partsKeyBody(bag, partValues) : { in: place, name: keyName.trim(), value: keyValue.trim() },
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; tests?: OriginTest[] };
      if (!res.ok) { setFailure({ text: data.error ?? "Something went wrong. Try again.", tests: data.tests }); return; }
      setKeyValue("");
      setPartValues((vs) => vs.map(() => ""));
      toast("Hirakumi now calls your new origin");
      router.refresh();
    } catch {
      setFailure({ text: "We couldn't reach Hirakumi. Check your connection and try again." });
    } finally {
      setSwitching(false);
    }
  }

  async function runCheck() {
    setChecking(true);
    try {
      const r = await postJson<DomainCheck>(`/api/apis/${p.apiId}/front-door/check`, {});
      setCheck(r);
      if (r.ok) router.refresh();
    } catch (e) {
      setCheck({ error: e instanceof RequestError ? e.message : "Something went wrong. Try again." });
    } finally {
      setChecking(false);
    }
  }

  async function stop() {
    const r = await deleteJson<{ host: string | null; undo?: string[] }>(`/api/apis/${p.apiId}/front-door`);
    toast(r.undo?.[0] ?? "Stopped using the front door");
    router.refresh();
  }

  const tab = (v: Placement) => (
    <button key={v} type="button" role="radio" aria-checked={place === v} disabled={switching || attached} onClick={() => setPlace(v)}
      className={cn("cursor-pointer rounded-[2px] border-2 border-ink px-3 py-1.5 text-body font-medium", place === v ? "bg-ink text-cream" : "bg-frost text-ink")}>
      {v === "header" ? "Header" : "Query parameter"}
    </button>
  );

  return (
    <ol className="space-y-4">
      <li aria-labelledby="fd-step-1" className="space-y-4 rounded-[2px] border-2 border-ink bg-frost p-4 sm:p-5">
        <StepHead n={1} done={attached} id="fd-step-1">Give your API a second hostname, with a key</StepHead>
        <div className="min-w-0 space-y-4 sm:pl-12">
          {attached ? (
            <p className="text-body">Hirakumi calls your API at <strong className="break-all">{p.origin}</strong>, with your key.</p>
          ) : (
            <form onSubmit={switchOrigin} aria-busy={switching || undefined} className="space-y-4">
              <p className="text-body">
                Serve the same API at a second hostname on your domain, like <code>origin.{p.publicHost.split(".").slice(1).join(".") || "example.com"}</code>, and
                make it answer only calls that carry your key. Hirakumi calls it there. <strong className="break-all">{p.publicHost}</strong> then points at Hirakumi.
              </p>
              <div className="space-y-2">
                <label htmlFor="fd-origin" className="block text-body font-medium">New origin</label>
                <Input id="fd-origin" type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://origin.example.com"
                  value={originText} onChange={(e) => setOriginText(e.target.value)} disabled={switching} />
              </div>
              {p.code && newHost && (
                <div className="space-y-2">
                  <p className="text-body">Add this TXT record for the new hostname too. It is the same code you proved {p.publicHost} with.</p>
                  <dl aria-label="TXT record for the new origin" className="min-w-0 rounded-[2px] border-2 border-ink bg-frost">
                    <RecordField label="Type" value="TXT" copy={false} />
                    <RecordField label="Name" value={`_hirakumi.${newHost}`} note="Also called Host." />
                    <RecordField label="Value" value={p.code} note="Not a secret." />
                  </dl>
                </div>
              )}
              {!p.code && <InlineError>This API has no DNS ownership code to reuse, so the front door can&apos;t be set up for it yet.</InlineError>}
              <div className="space-y-3">
                <p className="text-body font-medium">Your API&apos;s key</p>
                <p className="text-caption text-graphite">Required. Without it, anyone who finds the new hostname could call your API for free.</p>
                {bag ? (
                  <div className="grid gap-4 sm:grid-cols-2" data-testid="fd-key-parts">
                    {(bag.length === 1 ? [{ label: "User name" }, { label: "Password" }] : bag.map((x) => ({
                      label: `${x.in === "header" ? "Header" : "Query parameter"} ${x.name}${x.fixed ? " (fixed text)" : ""}`, fixed: x.fixed,
                    }))).map((f, i) => (
                      <div key={i} className="space-y-2">
                        <label htmlFor={`fd-key-part-${i}`} className="block text-body font-medium">{f.label}</label>
                        <Input id={`fd-key-part-${i}`} type={"fixed" in f && f.fixed ? "text" : "password"} autoComplete="off" spellCheck={false}
                          value={partValues[i] ?? ""} disabled={switching}
                          onChange={(e) => { const v = e.target.value; setPartValues((vs) => vs.map((old, j) => (j === i ? v : old))); }} />
                      </div>
                    ))}
                  </div>
                ) : (<>
                <div role="radiogroup" aria-label="Where the key goes" className="flex flex-wrap gap-2">{tab("header")}{tab("query")}</div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <label htmlFor="fd-key-name" className="block text-body font-medium">{place === "header" ? "Header name" : "Query parameter name"}</label>
                    <Input id="fd-key-name" autoComplete="off" spellCheck={false} placeholder={place === "header" ? "X-API-Key" : "api_key"}
                      value={keyName} onChange={(e) => setKeyName(e.target.value)} disabled={switching} />
                  </div>
                  <div className="space-y-2">
                    <label htmlFor="fd-key-value" className="block text-body font-medium">Key</label>
                    <Input id="fd-key-value" type="password" autoComplete="off" spellCheck={false} placeholder="Paste the key"
                      value={keyValue} onChange={(e) => setKeyValue(e.target.value)} disabled={switching} />
                  </div>
                </div>
                </>)}
              </div>
              <Button type="submit" disabled={switching || !p.code || !newHost || !keyReady} pending={switching} pendingLabel="Testing your new origin…">
                Test and switch
              </Button>
              <p className="text-caption text-graphite">Hirakumi checks both TXT records and makes one test call per endpoint at the new origin. Only when all pass does it switch.</p>
              {failure && (
                <ResultCard tone="fail" tag="Not switched" alert>
                  <p className="font-semibold">{failure.text}</p>
                  {failure.tests && (
                    <ul className="list-disc space-y-0.5 pl-5 text-caption">
                      {failure.tests.map((t) => <li key={t.opId}>{`${t.opId}: ${t.ok ? "passed" : t.detail}`}</li>)}
                    </ul>
                  )}
                </ResultCard>
              )}
            </form>
          )}
        </div>
      </li>

      <li aria-labelledby="fd-step-2" className={cn("space-y-4 rounded-[2px] border-2 border-ink bg-frost p-4 sm:p-5", !attached && "opacity-60")}>
        <StepHead n={2} done={connected} id="fd-step-2">Point {p.publicHost} at Hirakumi</StepHead>
        <div className="min-w-0 space-y-4 sm:pl-12">
          {!attached ? (
            <p className="text-body">Unlocks once Hirakumi calls your new origin.</p>
          ) : (
            <>
              {record ? (
                <dl aria-label="DNS record for the front door" className="min-w-0 rounded-[2px] border-2 border-ink bg-frost">
                  <RecordField label="Type" value={record.type} copy={false} />
                  <RecordField label="Name" value={p.publicHost} note="Also called Host. Many providers want only the part before your domain." />
                  <RecordField label="Value" value={record.value} note={record.type === "A" ? "An apex domain can't have a CNAME, so it gets an A record." : "Also called Target."} />
                </dl>
              ) : (
                <InlineError>We couldn&apos;t load the record to add. Reload the page.</InlineError>
              )}
              <WhereToAdd setup={setup} host={p.publicHost} />
              <ul className="list-disc space-y-1 pl-5 text-body">
                <li>Lower the record&apos;s TTL a few minutes before you change it, so callers move over quickly.</li>
                <li>Remove any AAAA record for {p.publicHost}. Every address must be Hirakumi&apos;s, or some callers still reach your server.</li>
                <li>On Cloudflare, set the record to DNS only (grey cloud). Proxied records hide where it points.</li>
                <li>The whole hostname moves: anything else served at {p.publicHost} goes through Hirakumi too.</li>
              </ul>
              <div className="flex flex-wrap items-center gap-4">
                <Button onClick={() => void runCheck()} pending={checking} pendingLabel="Checking…">Check connection</Button>
                <p className="text-caption text-graphite">Status: {DOMAIN_STATUS_LABEL[p.domain!.status]}</p>
              </div>
              {check && "error" in check && <InlineError>{check.error}</InlineError>}
              {check && "ok" in check && (
                <ResultCard tone={check.ok ? "pass" : "wait"} tag={check.ok ? "Connected" : "Not yet"}>
                  <p className="font-semibold">{check.detail}</p>
                  {!check.ok && <p className="text-caption">DNS changes can take a few minutes, sometimes up to an hour. Check again then.</p>}
                </ResultCard>
              )}
              {!check && p.domain?.lastError && p.domain.status !== "active" && <p className="text-caption text-graphite">Last check: {p.domain.lastError}</p>}
            </>
          )}
        </div>
      </li>

      {attached && (
        <li className="space-y-3 rounded-[2px] border-2 border-ink bg-frost p-4 sm:p-5">
          <h2 className="text-body-lg font-semibold">Stop using the front door</h2>
          <p className="text-body">Hirakumi stops answering {p.publicHost} at once. Your API stays on sale at Hirakumi&apos;s own URL, called at {p.origin}.</p>
          <ConfirmDialog
            triggerLabel="Stop using the front door" triggerVariant="destructive" triggerSize="default"
            title={`Stop answering ${p.publicHost}?`}
            description={`Callers at ${p.publicHost} get an error from Hirakumi until you point it back at your own server.`}
            details={<p className="text-body text-graphite">Point {p.publicHost} back at your server: replace the record to Hirakumi with the one it had before.</p>}
            confirmLabel="Stop" pendingLabel="Stopping…" onConfirm={stop}
          />
        </li>
      )}
    </ol>
  );
}

/** What someone calling the API's public hostname directly gets today. */
export function DirectCallerCard({ publicHost, origin, status, hasKey }: { publicHost: string; origin: string; status: DomainStatus | null; hasKey: boolean }) {
  const [tone, title, detail] = status === "active"
    ? ["pass", "Hirakumi's offer", `Callers at ${publicHost} get Hirakumi's 402 answer: this API is only available through Hirakumi, with a link to buy calls.`]
    : status === "pending_dns"
      ? ["wait", "Your server, for now", `${publicHost} still reaches your server until you point it at Hirakumi. Hirakumi already calls ${origin}.`]
      : hasKey
        ? ["wait", "Your server, with a key", `Callers reach your server at ${publicHost}. Without your key they should get your own error, but nothing says they buy through Hirakumi.`]
        : ["fail", "Your server, free", `Anyone can call ${publicHost} directly without paying. Use the front door so only Hirakumi's paid calls get through.`];
  return (
    <ResultCard tone={tone as "pass" | "wait" | "fail"} tag={title}>
      <p className="font-semibold">What a direct caller gets today</p>
      <p>{detail}</p>
    </ResultCard>
  );
}
