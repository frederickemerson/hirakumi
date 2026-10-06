"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Elapsed, useElapsed } from "@/components/elapsed";
import { InlineError, InlineStatus } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PhoneWalletConnect } from "@/components/phone-wallet-connect";
import { GetAWallet, useWallets, WalletIcon } from "@/components/wallet-picker";
import { postJson, RequestError } from "@/lib/client-fetch";
import type { ChallengeCheck } from "@/lib/gateway";
import { startRouteProgress } from "@/lib/route-progress";
import { connectWallet, signText, walletErrorMessage } from "@/lib/wallet-client";
import { cn } from "@/lib/utils";

/** How often the page re-reads the seller's OpenAPI file while it is visible. */
export const AUTO_CHECK_MS = 10_000;
const FIELD = "x-hirakumi-verify";

/** The line the seller adds at the root of their OpenAPI file, in each format. */
export function specSnippets(code: string): { yaml: string; json: string } {
  return { yaml: `${FIELD}: "${code}"`, json: `"${FIELD}": "${code}",` };
}

type CheckState =
  | { kind: "waiting" }
  | { kind: "failed"; result: ChallengeCheck }
  | { kind: "error"; text: string };
type SignState = { kind: "idle" } | { kind: "working"; walletId: string; text: string; message?: string } | { kind: "error"; text: string };

/** One sentence naming what the check found. Short, plain, no dashes. */
function headline(r: ChallengeCheck): string {
  switch (r.reason) {
    case "http_status":
      return `We couldn't fetch the file. Your server answered ${r.status ?? "an error"}.`;
    case "redirect":
      return `We couldn't fetch the file. Your server answered ${r.status ?? "3xx"}, a redirect.`;
    case "timeout":
    case "unreachable":
    case "blocked":
    case "too_large":
      return "We couldn't fetch the file.";
    case "unreadable":
      return "We fetched the file, but it isn't valid JSON or YAML.";
    case "missing":
      return `We read the file, but ${FIELD} is missing at the root.`;
    case "mismatch":
      return `We found ${FIELD}, but the code doesn't match this API's code.`;
    case "origin_mismatch":
    case "outside_directory":
    case "bad_url":
      return "This file can't prove you own this API.";
    default:
      return "The check didn't pass.";
  }
}
/** The gateway's detail adds facts (why a fetch failed, which folder) beyond the headline for these. */
const SHOW_DETAIL = new Set<ChallengeCheck["reason"]>(["timeout", "unreachable", "blocked", "too_large", "origin_mismatch", "outside_directory", "bad_url", "no_code"]);

function StepNumber({ n, done }: { n: number; done?: boolean }) {
  return (
    <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-[2px] border-2 border-ink text-body font-semibold tabular-nums", done ? "bg-mint/50" : "bg-canary")}>
      {done ? "✓" : n}
    </span>
  );
}

function Snippet({ label, text }: { label: "YAML" | "JSON"; text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="rounded-[2px] border-2 border-ink">
      <div className="flex items-center justify-between gap-4 border-b-2 border-ink px-3 py-1.5">
        <span className="text-caption font-semibold uppercase tracking-[0.04em]">{label}</span>
        <Button variant="outline" size="xs" onClick={copy} aria-live="polite">{copied ? "Copied" : `Copy ${label}`}</Button>
      </div>
      <pre className="overflow-x-auto bg-ink p-3 text-caption text-cream"><code>{text}</code></pre>
    </div>
  );
}

const isVisible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

export function OwnershipPanel({ apiId, openapiUrl, code, initiallyPassed }: {
  apiId: string;
  /** The API's openapi_url: the file the code must be added to. */
  openapiUrl: string;
  /** This API's verification code (server-side, per API). */
  code: string;
  initiallyPassed: boolean;
}) {
  const router = useRouter();
  const [passed, setPassed] = useState(initiallyPassed);
  const [check, setCheck] = useState<CheckState>({ kind: "waiting" });
  const [inFlight, setInFlight] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [sign, setSign] = useState<SignState>({ kind: "idle" });
  const [signed, setSigned] = useState(false);
  const wallets = useWallets();
  const sinceLast = useElapsed(lastCheckedAt, !passed && lastCheckedAt !== null);
  const busy = useRef(false);
  const lastStarted = useRef(0);
  const snippets = specSnippets(code);

  async function runCheck() {
    if (busy.current) return;
    busy.current = true;
    lastStarted.current = Date.now();
    setInFlight(true);
    try {
      const result = await postJson<ChallengeCheck>(`/api/apis/${apiId}/ownership/spec-check`, {});
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

  // Check on open, then every AUTO_CHECK_MS while the page is visible, until the code is found.
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
      const challenge = await postJson<{ challengeId: string; message: string }>(`/api/apis/${apiId}/ownership/wallet-challenge`, {});
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

  return (
    <ol className="space-y-4">
      <li aria-labelledby="own-step-1" className="flex gap-4 rounded-[2px] border-2 border-ink bg-frost p-5">
        <StepNumber n={1} done={passed} />
        <div className="min-w-0 flex-1 space-y-3">
          <h2 id="own-step-1" className="text-body-lg font-semibold">Add your code</h2>
          <p className="text-body">So nobody can sell an API they don&apos;t own.</p>
          <p className="text-body">Add this line at the root of your OpenAPI file, next to <code>openapi</code> and <code>info</code>:</p>
          <div className="grid gap-3 md:grid-cols-2">
            <Snippet label="YAML" text={snippets.yaml} />
            <Snippet label="JSON" text={snippets.json} />
          </div>
          <p className="text-body">Your OpenAPI file:</p>
          <code className="block break-all rounded-[2px] bg-ink p-3 text-body text-cream">{openapiUrl}</code>
          {passed ? (
            <InlineStatus>Found your code.</InlineStatus>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-4">
                <Button variant="outline" pending={inFlight} pendingLabel="Checking…" onClick={() => void runCheck()}>Check now</Button>
                <p role="status" aria-live="off" className="min-w-0 break-all text-caption text-graphite">
                  Checking {openapiUrl}…{sinceLast !== null && !inFlight ? ` last checked ${sinceLast} s ago` : ""}
                </p>
              </div>
              {check.kind === "failed" && (
                <div role="alert" className="space-y-2 border-l-4 border-coral pl-3 text-body">
                  <p className="font-semibold">{headline(check.result)}</p>
                  {SHOW_DETAIL.has(check.result.reason) && <p>{check.result.detail}</p>}
                  <ul className="list-disc space-y-0.5 pl-5 text-caption">
                    <li>Serve the file at this exact URL. Redirects are not followed.</li>
                    <li>Use HTTPS.</li>
                    <li>Publish the updated file. We check again every 10 s.</li>
                  </ul>
                </div>
              )}
              {check.kind === "error" && <InlineError>{check.text}</InlineError>}
            </div>
          )}
        </div>
      </li>
      <li aria-labelledby="own-step-2" className="flex gap-4 rounded-[2px] border-2 border-ink bg-frost p-5">
        <StepNumber n={2} done={signed} />
        <div className="min-w-0 flex-1 space-y-3">
          <h2 id="own-step-2" className="text-body-lg font-semibold">Sign with your wallet</h2>
          <p className="text-body">
            Your wallet shows a message naming this API and the address buyers will pay. Signing costs nothing and moves no funds.
          </p>
          {!passed && <p className="text-caption text-graphite">Signing unlocks once we find your code.</p>}
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
