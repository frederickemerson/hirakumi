"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Elapsed } from "@/components/elapsed";
import { InlineError, InlineStatus } from "@/components/states";
import { Button } from "@/components/ui/button";
import { postJson, RequestError } from "@/lib/client-fetch";
import { startRouteProgress } from "@/lib/route-progress";
import { connectWallet, listWallets, signText, walletErrorMessage, type WalletInfo } from "@/lib/wallet-client";
import { cn } from "@/lib/utils";

type CheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "failed"; triedUrl: string; detail: string }
  | { kind: "error"; text: string };
type SignState = { kind: "idle" } | { kind: "working"; walletId: string; text: string; message?: string } | { kind: "error"; text: string };

function StepNumber({ n, done }: { n: number; done?: boolean }) {
  return (
    <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-[2px] border-2 border-ink text-body font-semibold tabular-nums", done ? "bg-mint/50" : "bg-canary")}>
      {done ? "✓" : n}
    </span>
  );
}

export function OwnershipPanel({ apiId, fileUrl, initiallyPassed }: { apiId: string; fileUrl: string; initiallyPassed: boolean }) {
  const router = useRouter();
  const [passed, setPassed] = useState(initiallyPassed);
  const [check, setCheck] = useState<CheckState>({ kind: "idle" });
  const [sign, setSign] = useState<SignState>({ kind: "idle" });
  const [wallets, setWallets] = useState<WalletInfo[]>([]);

  useEffect(() => {
    setWallets(listWallets());
    const t = setTimeout(() => setWallets(listWallets()), 800);
    return () => clearTimeout(t);
  }, []);

  async function runCheck() {
    setCheck({ kind: "checking" });
    try {
      const result = await postJson<{ ok: boolean; triedUrl: string; detail: string }>(`/api/apis/${apiId}/ownership/http-check`, {});
      if (result.ok) {
        setPassed(true);
        setCheck({ kind: "idle" });
      } else {
        setPassed(false);
        setCheck({ kind: "failed", triedUrl: result.triedUrl, detail: result.detail });
      }
    } catch (e) {
      setCheck({ kind: "error", text: e instanceof RequestError ? e.message : "Something went wrong. Try again." });
    }
  }

  async function runSign(walletId: string) {
    try {
      setSign({ kind: "working", walletId, text: "Connecting to your wallet…" });
      const { api, addressHex } = await connectWallet(walletId);
      const challenge = await postJson<{ challengeId: string; message: string }>(`/api/apis/${apiId}/ownership/wallet-challenge`, {});
      setSign({ kind: "working", walletId, text: "Approve this message in your wallet. It costs nothing and moves no funds.", message: challenge.message });
      const sig = await signText(api, addressHex, challenge.message);
      setSign({ kind: "working", walletId, text: "Signature received. Checking it…" });
      await postJson(`/api/apis/${apiId}/ownership/verify`, { challengeId: challenge.challengeId, address: addressHex, ...sig });
      startRouteProgress();
      router.push(`/apis/${apiId}/review`);
    } catch (e) {
      setSign({ kind: "error", text: walletErrorMessage(e) });
    }
  }

  const signing = sign.kind === "working";

  return (
    <ol className="space-y-4">
      <li className="flex gap-4 rounded-[2px] border-2 border-ink bg-frost p-5">
        <StepNumber n={1} done={passed} />
        <div className="min-w-0 flex-1 space-y-2">
          <h2 className="text-body-lg font-semibold">Put the verification file on your server</h2>
          <p className="text-body">Download the file and upload it, unchanged, so it opens at:</p>
          <code className="block break-all rounded-[2px] bg-ink p-3 text-body text-cream">{fileUrl}</code>
          <a href={`/api/apis/${apiId}/challenge-file`} download className="inline-block text-body underline underline-offset-4">Download the file</a>
          <p className="text-caption text-graphite">The file works once and expires after 30 minutes.</p>
        </div>
      </li>
      <li className="flex gap-4 rounded-[2px] border-2 border-ink bg-frost p-5">
        <StepNumber n={2} done={passed} />
        <div className="min-w-0 flex-1 space-y-3">
          <h2 className="text-body-lg font-semibold">Check the file</h2>
          <div className="flex flex-wrap items-center gap-4">
            <Button variant="outline" pending={check.kind === "checking"} pendingLabel="Checking…" onClick={runCheck}>Check</Button>
            {check.kind === "checking" && (
              <InlineStatus busy>
                Fetching the file from your server <Elapsed prefix=" " className="text-graphite" />
              </InlineStatus>
            )}
          </div>
          {passed && <InlineStatus>Found it. Your file matches.</InlineStatus>}
          {check.kind === "failed" && (
            <div role="alert" className="space-y-1 border-l-4 border-coral pl-3 text-body">
              <p>We couldn&apos;t confirm the file. We tried {check.triedUrl}</p>
              <p>{check.detail}</p>
            </div>
          )}
          {check.kind === "error" && <InlineError>{check.text}</InlineError>}
        </div>
      </li>
      <li className="flex gap-4 rounded-[2px] border-2 border-ink bg-frost p-5">
        <StepNumber n={3} />
        <div className="min-w-0 flex-1 space-y-3">
          <h2 className="text-body-lg font-semibold">Sign with your wallet</h2>
          <p className="text-body">
            Your wallet shows a message naming this API and the address buyers will pay. Signing costs nothing and moves no funds.
          </p>
          {!passed && <p className="text-caption text-graphite">Check the file first; signing unlocks after it passes.</p>}
          {wallets.length === 0 ? (
            <p className="text-body">No Cardano wallet found in this browser. Install Lace or Eternl, switch it to Preprod, then reload.</p>
          ) : (
            <div className="flex flex-wrap gap-4">
              {wallets.map((w) => (
                <Button key={w.id} disabled={!passed || signing} pending={signing && sign.walletId === w.id} onClick={() => runSign(w.id)}>
                  Sign with {w.name}
                </Button>
              ))}
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
