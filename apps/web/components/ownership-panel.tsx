"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { askHirakumi } from "@/components/ask-hirakumi";
import { CopyButton } from "@/components/copy-button";
import { Elapsed, useElapsed } from "@/components/elapsed";
import { InlineError } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { PhoneWalletConnect } from "@/components/phone-wallet-connect";
import { GetAWallet, useWallets, WalletIcon } from "@/components/wallet-picker";
import { postJson, RequestError } from "@/lib/client-fetch";
import { DNS_HELP_QUESTION } from "@/lib/ask/shared";
import { providerName, providerWhere, relativeName, type DnsSetup } from "@/lib/dns-provider";
import type { ChallengeCheck } from "@/lib/gateway";
import { startRouteProgress } from "@/lib/route-progress";
import { connectWallet, signText, walletErrorMessage } from "@/lib/wallet-client";
import { cn } from "@/lib/utils";

/** How often the page looks up the seller's DNS record while it is visible. */
export const AUTO_CHECK_MS = 10_000;

/** A shell word: single quotes, any ' inside closed and escaped. */
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The command a seller can run to see the record themselves. */
export function digCheck(recordName: string): string {
  return `dig +short TXT ${shellQuote(recordName)}`;
}

/** Vercel DNS from the terminal: the record, in one command. */
export function vercelDnsCommand(zone: string, name: string, code: string): string {
  return `vercel dns add ${zone} ${name} TXT ${code}`;
}

/** What Ask Hirakumi is asked by the help button: the seller's own provider when it is known. */
export function helpQuestion(setup: DnsSetup | null): string {
  return setup?.provider
    ? `How do I add the _hirakumi TXT record on ${providerName(setup.provider)}?`
    : DNS_HELP_QUESTION;
}

const checkUrl = (apiId: string) => `/api/apis/${apiId}/ownership/dns-check`;

type CheckState =
  | { kind: "waiting" }
  | { kind: "failed"; result: ChallengeCheck }
  | { kind: "error"; text: string };
type SignState = { kind: "idle" } | { kind: "working"; walletId: string; text: string; message?: string } | { kind: "error"; text: string };

/**
 * Not there yet is the normal state while DNS catches up, and a DNS server that didn't answer is retried: both wait.
 * Only a record with another code or a host that can't have one is a real failure.
 */
const WAITING = new Set<ChallengeCheck["reason"]>(["missing", "timeout", "unreachable"]);

/** One sentence naming what the check found. Short, plain, no dashes. */
function headline(r: ChallengeCheck): string {
  switch (r.reason) {
    case "missing": return `No TXT record at ${r.record} yet.`;
    case "timeout":
    case "unreachable": return "DNS didn't answer this time. We'll look again.";
    case "mismatch": return `There is a TXT record at ${r.record}, but not with this API's code.`;
    case "bad_host": return "This address can't have a DNS record.";
    default: return "The check didn't pass.";
  }
}

/** What to do next, for this result only. */
function nextSteps(r: ChallengeCheck): string[] {
  switch (r.reason) {
    case "missing":
      return [
        "Save the record at your DNS provider if you haven't yet. New records usually show within a few minutes, sometimes up to an hour. We look every 10 s.",
        "Check the Name: many providers add your domain to it for you. If you typed the full name there, it may have become the full name twice.",
        "Run the dig command above. It prints your code once the record is live.",
      ];
    case "mismatch":
      return [
        "Copy the value again from this step. It must match exactly, with no spaces around it.",
        "Another API on this host may have its own _hirakumi record. Keep it and add this one too: a name can hold several TXT records.",
      ];
    case "bad_host":
      return ["Give your API a domain name in its setup, like api.example.com, then come back here."];
    default:
      return [];
  }
}

function StepNumber({ n, done }: { n: number; done?: boolean }) {
  return (
    <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-[2px] border-2 border-ink text-body font-semibold tabular-nums", done ? "bg-mint/50" : "bg-canary")}>
      {done ? "✓" : n}
    </span>
  );
}

export function StepHead({ n, done, id, children }: { n: number; done?: boolean; id: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4">
      <StepNumber n={n} done={done} />
      <h2 id={id} className="text-body-lg font-semibold">{children}</h2>
    </div>
  );
}

/** A labelled code block with one Copy button. Long lines scroll inside the box, never the page. */
export function Snippet({ label, text, copyLabel }: { label: string; text: string; copyLabel?: string }) {
  return (
    <div className="min-w-0 rounded-[2px] border-2 border-ink bg-frost">
      <div className="flex items-center justify-between gap-3 border-b-2 border-ink py-1 pr-1 pl-3">
        <span className="truncate text-caption font-semibold uppercase tracking-[0.04em]">{label}</span>
        <CopyButton value={text} ariaLabel={copyLabel ?? `Copy ${label}`} variant="ghost" />
      </div>
      <pre tabIndex={0} aria-label={label} className="overflow-x-auto bg-ink p-3 text-caption leading-relaxed text-cream"><code>{text}</code></pre>
    </div>
  );
}

function SubHeading({ id, kicker, children }: { id: string; kicker: string; children: ReactNode }) {
  return (
    <h3 id={id} className="flex items-baseline gap-2 text-body font-semibold">
      <span aria-hidden className="text-caption text-bill">{kicker}</span>
      {children}
    </h3>
  );
}

/** One field of the record, the way DNS dashboards lay it out: its label, the value, and a Copy button. */
export function RecordField({ label, value, note, copy = true }: { label: string; value: string; note?: ReactNode; copy?: boolean }) {
  return (
    <div className="grid min-w-0 gap-1 border-b-2 border-ink px-3 py-2 last:border-b-0 sm:grid-cols-[6rem_1fr_auto] sm:items-center sm:gap-3">
      <dt className="text-caption font-semibold uppercase tracking-[0.04em] text-graphite">{label}</dt>
      <dd className="min-w-0 space-y-0.5">
        <code className="block text-body break-all">{value}</code>
        {note && <p className="text-caption text-graphite">{note}</p>}
      </dd>
      {copy ? <CopyButton value={value} ariaLabel={`Copy ${label.toLowerCase()}`} variant="ghost" /> : <span />}
    </div>
  );
}

/** Resolves the DNS hint once; undefined while the lookup is still running, null when none was asked for. */
export function useDnsSetup(dns: Promise<DnsSetup> | undefined): DnsSetup | null | undefined {
  const [setup, setSetup] = useState<DnsSetup | null | undefined>(dns ? undefined : null);
  useEffect(() => {
    if (!dns) return;
    let live = true;
    dns.then((s) => live && setSetup(s), () => live && setSetup(null));
    return () => {
      live = false;
    };
  }, [dns]);
  return setup;
}

/** Where to add the record: the provider's own steps when its nameservers name it, else the general ones. */
export function WhereToAdd({ setup, host }: { setup: DnsSetup | null | undefined; host: string }) {
  if (setup === undefined) {
    return (
      <p role="status" aria-live="polite" className="flex min-h-6 items-center gap-2 text-caption text-graphite">
        <Spinner className="size-3" /> Finding where your domain&apos;s DNS is managed…
      </p>
    );
  }
  if (setup?.sharedSuffix) {
    return (
      <div role="status" className="space-y-1 border-l-4 border-coral pl-3 text-body">
        <p className="font-semibold">{host} is on {setup.sharedSuffix}, a platform&apos;s shared domain.</p>
        <p>Only the platform can add DNS records there. Connect your own domain to your API (your host&apos;s custom domain settings), change the API&apos;s address in its setup, then come back.</p>
      </div>
    );
  }
  return (
    <p role="status" aria-live="polite" className="text-body">
      {setup?.provider
        ? <>Your DNS is on <strong>{providerName(setup.provider)}</strong>. {providerWhere(setup.provider)}</>
        : "Add it where your domain's DNS is managed: often your registrar (where you bought the domain) or Cloudflare."}
    </p>
  );
}

/** The check's answer: a tag naming the outcome, then what was found and what to do. Ink text, colour on the rule only. */
export function ResultCard({ tone, tag, alert, children }: { tone: "pass" | "wait" | "fail"; tag: string; alert?: boolean; children: ReactNode }) {
  return (
    <div role={alert ? "alert" : "status"} aria-live={alert ? undefined : "polite"}
      className={cn("space-y-2 rounded-[2px] border-2 border-ink border-l-8 bg-frost p-4 text-body",
        tone === "pass" ? "border-l-mint" : tone === "wait" ? "border-l-sky" : "border-l-coral")}>
      <Badge variant={tone === "pass" ? "mint" : tone === "wait" ? "sky" : "destructive"}>{tag}</Badge>
      {children}
    </div>
  );
}

const isVisible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

export function OwnershipPanel({ apiId, host, recordName, code, initiallyPassed, beforeSigning, dns }: {
  apiId: string;
  /** The API's hostname: the DNS name the record proves. */
  host: string;
  /** The TXT record's full name: _hirakumi.<host>. */
  recordName: string;
  /** This API's verification code (server-side, per API): the record's value. */
  code: string;
  initiallyPassed: boolean;
  /** Shown between the two steps: the optional key for the API (components/upstream-auth-form.tsx). */
  beforeSigning?: ReactNode;
  /** Where the host's DNS is managed (app/apis/[apiId]/ownership/probe-dns.ts), streamed in. */
  dns?: Promise<DnsSetup>;
}) {
  const router = useRouter();
  const [passed, setPassed] = useState(initiallyPassed);
  const [check, setCheck] = useState<CheckState>({ kind: "waiting" });
  const [inFlight, setInFlight] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [sign, setSign] = useState<SignState>({ kind: "idle" });
  const [signed, setSigned] = useState(false);
  const wallets = useWallets();
  const setup = useDnsSetup(dns);
  const sinceLast = useElapsed(lastCheckedAt, !passed && lastCheckedAt !== null);
  const checkingFor = useElapsed(startedAt, inFlight);
  const busy = useRef(false);
  const lastStarted = useRef(0);
  const shortName = setup?.zone ? relativeName(recordName, setup.zone) : null;

  async function runCheck() {
    if (busy.current) return;
    busy.current = true;
    lastStarted.current = Date.now();
    setStartedAt(lastStarted.current);
    setInFlight(true);
    try {
      const result = await postJson<ChallengeCheck>(checkUrl(apiId), {});
      if (result.ok) {
        setPassed(true);
        setCheck({ kind: "waiting" });
      } else {
        setCheck({ kind: "failed", result });
      }
    } catch (e) {
      setCheck({ kind: "error", text: e instanceof RequestError ? e.message : "Something went wrong. Try again." });
    } finally {
      busy.current = false;
      setInFlight(false);
      setLastCheckedAt(Date.now());
    }
  }
  const runCheckRef = useRef(runCheck);
  runCheckRef.current = runCheck;

  // Check on open, then every AUTO_CHECK_MS while the page is visible, until the record is found.
  useEffect(() => {
    if (passed) return;
    const tick = () => {
      if (isVisible() && Date.now() - lastStarted.current >= AUTO_CHECK_MS - 250) void runCheckRef.current();
    };
    tick();
    const timer = setInterval(tick, AUTO_CHECK_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [passed]);

  async function runSign(walletId: string) {
    try {
      setSign({ kind: "working", walletId, text: "Connecting to your wallet…" });
      const { api, addressHex } = await connectWallet(walletId);
      const challengeUrl = `/api/apis/${apiId}/ownership/wallet-challenge`;
      let challenge: { challengeId: string; message: string };
      try {
        challenge = await postJson(challengeUrl, {});
      } catch (e) {
        // 409: the DNS pass is older than VERIFY_PASS_TTL_MINUTES. Look the record up again instead of a dead end.
        if (!(e instanceof RequestError && e.status === 409)) throw e;
        setSign({ kind: "working", walletId, text: "Checking your DNS record again…" });
        const again = await postJson<ChallengeCheck>(checkUrl(apiId), {});
        if (!again.ok) {
          setPassed(false);
          setCheck({ kind: "failed", result: again });
          setLastCheckedAt(Date.now());
          setSign({ kind: "error", text: "We can't find your DNS record anymore. Add it back, then sign." });
          return;
        }
        challenge = await postJson(challengeUrl, {});
      }
      setSign({ kind: "working", walletId, text: "Approve this message in your wallet. It costs nothing and moves no funds.", message: challenge.message });
      const sig = await signText(api, addressHex, challenge.message);
      setSign({ kind: "working", walletId, text: "Signature received. Checking it…" });
      await postJson(`/api/apis/${apiId}/ownership/verify`, { challengeId: challenge.challengeId, address: addressHex, ...sig });
      setSigned(true);
      setSign({ kind: "working", walletId, text: "Ownership proven. Opening the next step…" });
      startRouteProgress();
      router.push(`/apis/${apiId}/review`);
    } catch (e) {
      setSign({ kind: "error", text: walletErrorMessage(e) });
    }
  }

  const signing = sign.kind === "working";
  const waiting = check.kind === "failed" && WAITING.has(check.result.reason);

  return (
    <ol className="space-y-4">
      <li aria-labelledby="own-step-1" className="space-y-4 rounded-[2px] border-2 border-ink bg-frost p-4 sm:p-5">
        <StepHead n={1} done={passed} id="own-step-1">Add a DNS record</StepHead>
        <div className="min-w-0 space-y-6 sm:pl-12">
          <div className="space-y-3">
            <p className="text-body">
              So nobody can sell an API they don&apos;t own. Add this TXT record to the DNS of <strong className="break-all">{host}</strong>. Your API itself doesn&apos;t change, whatever it runs on.
            </p>
            <dl aria-label="DNS record" className="min-w-0 rounded-[2px] border-2 border-ink bg-frost">
              <RecordField label="Type" value="TXT" copy={false} />
              <RecordField label="Name" value={shortName ?? recordName}
                note={shortName && shortName !== recordName ? <>Also called Host. The full name is <span className="break-all">{recordName}</span>.</> : "Also called Host. If your provider adds your domain for you, type only the part before it."} />
              <RecordField label="Value" value={code} note="Also called Content or Data. Not a secret." />
            </dl>
            <WhereToAdd setup={setup} host={host} />
            {setup?.provider === "vercel" && setup.zone && shortName && (
              <Snippet label="Vercel CLI" text={vercelDnsCommand(setup.zone, shortName, code)} copyLabel="Copy Vercel command" />
            )}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Button variant="outline" size="sm" onClick={() => askHirakumi(helpQuestion(setup ?? null))}>Ask Hirakumi how</Button>
              <p className="text-caption text-graphite">Stuck on a step? Hirakumi knows your record and walks you through it.</p>
            </div>
          </div>

          <section aria-labelledby="test-it" className="space-y-3 border-t-2 border-dashed border-silver pt-5">
            <SubHeading id="test-it" kicker="Then">Test it</SubHeading>
            <p className="text-body">Run this. It prints your code once the record is live.</p>
            <Snippet label="dig" text={digCheck(recordName)} copyLabel="Copy dig command" />
            {passed ? (
              <ResultCard tone="pass" tag="Found">
                <p className="font-semibold">Found your record.</p>
                <p>Keep it in place while your API is listed. Sign with your wallet below to finish.</p>
              </ResultCard>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <Button pending={inFlight} pendingLabel="Checking…" onClick={() => void runCheck()}>Check now</Button>
                  <p role="status" aria-live="off" className="min-w-0 flex-1 basis-56 text-caption [overflow-wrap:anywhere] text-graphite tabular-nums">
                    {inFlight
                      ? `Looking up ${recordName}…${checkingFor ? ` ${checkingFor} s` : ""}`
                      : `${sinceLast !== null ? `Last checked ${sinceLast} s ago. ` : ""}We look every 10 s while this page is open.`}
                  </p>
                </div>
                {check.kind === "failed" && (
                  <ResultCard tone={waiting ? "wait" : "fail"} tag={waiting ? "Waiting" : check.result.reason === "mismatch" ? "Wrong value" : "Can't check"} alert={!waiting}>
                    <p className="font-semibold">{headline(check.result)}</p>
                    {check.result.reason === "bad_host" && <p>{check.result.detail}</p>}
                    <ul className="list-disc space-y-0.5 pl-5 text-caption">
                      {nextSteps(check.result).map((t) => <li key={t}>{t}</li>)}
                    </ul>
                  </ResultCard>
                )}
                {check.kind === "error" && <InlineError>{check.text}</InlineError>}
              </div>
            )}
          </section>
        </div>
      </li>
      {beforeSigning && <li>{beforeSigning}</li>}
      <li aria-labelledby="own-step-2" className="space-y-3 rounded-[2px] border-2 border-ink bg-frost p-4 sm:p-5">
        <StepHead n={2} done={signed} id="own-step-2">Sign with your wallet</StepHead>
        <div className="min-w-0 space-y-3 sm:pl-12">
          <p className="text-body">
            Your wallet shows a message naming this API and the address buyers will pay. Signing costs nothing and moves no funds.
          </p>
          {!passed && <p className="text-caption text-graphite">Signing unlocks once we find your record.</p>}
          {wallets === null ? (
            <div role="status" aria-label="Looking for wallets" className="flex flex-wrap gap-4">
              <Skeleton className="h-11 w-44" />
              <Skeleton className="h-11 w-44" />
            </div>
          ) : wallets.length === 0 ? (
            <div className="space-y-3">
              {passed && !signed && <PhoneWalletConnect onConnected={(id) => runSign(id)} />}
              <GetAWallet />
            </div>
          ) : (
            <div className="flex flex-wrap gap-4">
              {wallets.map((w) => (
                <Button key={w.id} disabled={!passed || signing || signed} pending={signing && sign.walletId === w.id} onClick={() => runSign(w.id)}>
                  {!(signing && sign.walletId === w.id) && <WalletIcon icon={w.icon} />}
                  Sign with {w.name}
                </Button>
              ))}
              {passed && !signed && <PhoneWalletConnect onConnected={(id) => runSign(id)} />}
            </div>
          )}
          {sign.kind === "working" && (
            <div role="status" aria-live="polite" className="space-y-2 border-l-4 border-sky pl-3 text-body">
              <p>{sign.text} <Elapsed prefix=" " className="text-graphite" /></p>
              {sign.message && <pre className="whitespace-pre-wrap rounded-[2px] bg-ink p-3 text-caption text-cream">{sign.message}</pre>}
            </div>
          )}
          {sign.kind === "error" && <InlineError>{sign.text}</InlineError>}
        </div>
      </li>
    </ol>
  );
}
