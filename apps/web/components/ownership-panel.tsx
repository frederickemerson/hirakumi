"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { postJson, RequestError } from "@/lib/client-fetch";
import { connectWallet, listWallets, signText, walletErrorMessage, type WalletInfo } from "@/lib/wallet-client";

type CheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "failed"; triedUrl: string; detail: string }
  | { kind: "error"; text: string };
type SignState = { kind: "idle" } | { kind: "working"; text: string; message?: string } | { kind: "error"; text: string };

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
      setSign({ kind: "working", text: "Connecting to your wallet…" });
      const { api, addressHex } = await connectWallet(walletId);
      const challenge = await postJson<{ challengeId: string; message: string }>(`/api/apis/${apiId}/ownership/wallet-challenge`, {});
      setSign({ kind: "working", text: "Approve this message in your wallet. It costs nothing and moves no funds.", message: challenge.message });
      const sig = await signText(api, addressHex, challenge.message);
      await postJson(`/api/apis/${apiId}/ownership/verify`, { challengeId: challenge.challengeId, address: addressHex, ...sig });
      router.push(`/apis/${apiId}/review`);
    } catch (e) {
      setSign({ kind: "error", text: walletErrorMessage(e) });
    }
  }

  return (
    <ol className="space-y-8">
      <li className="space-y-2">
        <h2 className="font-medium">1. Put the verification file on your server</h2>
        <p className="text-sm text-muted-foreground">Download the file and upload it, unchanged, so it opens at:</p>
        <code className="block break-all rounded bg-muted p-2 text-sm">{fileUrl}</code>
        <a href={`/api/apis/${apiId}/challenge-file`} download className="text-sm underline">Download the file</a>
        <p className="text-xs text-muted-foreground">The file works once and expires after 30 minutes.</p>
      </li>
      <li className="space-y-2">
        <h2 className="font-medium">2. Check the file</h2>
        <Button variant="outline" disabled={check.kind === "checking"} onClick={runCheck}>
          {check.kind === "checking" ? "Checking…" : "Check"}
        </Button>
        {passed && <p role="status" className="text-sm text-green-700">Found it. Your file matches.</p>}
        {check.kind === "failed" && (
          <div role="alert" className="space-y-1 text-sm text-destructive">
            <p>We couldn't confirm the file. We tried {check.triedUrl}</p>
            <p>{check.detail}</p>
          </div>
        )}
        {check.kind === "error" && <p role="alert" className="text-sm text-destructive">{check.text}</p>}
      </li>
      <li className="space-y-2">
        <h2 className="font-medium">3. Sign with your wallet</h2>
        <p className="text-sm text-muted-foreground">
          Your wallet shows a message naming this API and the address buyers will pay. Signing costs nothing and moves no funds.
        </p>
        {wallets.length === 0 ? (
          <p className="text-sm">No Cardano wallet found in this browser. Install Lace or Eternl, switch it to Preprod, then reload.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {wallets.map((w) => (
              <Button key={w.id} disabled={!passed || sign.kind === "working"} onClick={() => runSign(w.id)}>
                Sign with {w.name}
              </Button>
            ))}
          </div>
        )}
        {sign.kind === "working" && (
          <div role="status" className="space-y-2 text-sm">
            <p>{sign.text}</p>
            {sign.message && <pre className="whitespace-pre-wrap rounded bg-muted p-2 text-xs">{sign.message}</pre>}
          </div>
        )}
        {sign.kind === "error" && <p role="alert" className="text-sm text-destructive">{sign.text}</p>}
      </li>
    </ol>
  );
}
