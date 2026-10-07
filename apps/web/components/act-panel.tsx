"use client";

import { useState } from "react";
import { Elapsed } from "@/components/elapsed";
import { PhoneWalletConnect } from "@/components/phone-wallet-connect";
import { InlineError, InlineStatus } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { withPrefix } from "@/components/upstream-auth-form";
import { BROWSER_WALLET_TOO, GetAWallet, onlyEmailWallet, useIsMobile, useWallets, WalletIcon } from "@/components/wallet-picker";
import { postJson, RequestError } from "@/lib/client-fetch";
import { connectWallet, needsAnotherClick, signText, walletAction, walletErrorMessage } from "@/lib/wallet-client";

type Placement = "header" | "query";
export type ActKeyHint = { in: Placement; name: string; prefix?: string };
export type ActAction = "ownership" | "key" | "publish";

type Phase =
  | { kind: "idle" }
  | { kind: "working"; walletId: string; text: string; message?: string }
  | { kind: "again"; text: string }
  | { kind: "error"; text: string; keyRefused?: boolean }
  | { kind: "done"; text: string };

type Challenge = { kind: "wallet"; challengeId: string; message: string } | { kind: "act"; nonceToken: string; message: string };

export const DONE_TEXT = "Done. You can close this tab; the rest continues in Sokosumi.";

/**
 * One wallet step from a Sokosumi comment (/act/<token>): pick a wallet, sign once, done. Signing in is the
 * signature itself: the server checks it against the API owner's wallet. For ownership and key links the API's key
 * can go in here; it is sent once over HTTPS and sealed on the server for the gateway, exactly as the key form does
 * (lib/upstream-key-save.ts), and never shown again.
 */
export function ActPanel({ token, action, title, wallet, keyHint }: {
  token: string;
  action: ActAction;
  /** "Sign to prove you own weather.example.com". */
  title: string;
  /** The wallet this link is for: "…abc123". */
  wallet: string;
  /** Where the key goes, from the OpenAPI file; null when it doesn't say. */
  keyHint: ActKeyHint | null;
}) {
  const wallets = useWallets();
  const mobile = useIsMobile();
  const keyAsked = action === "key";
  const keyOffered = action !== "publish";
  const [withKey, setWithKey] = useState(keyAsked || !!keyHint);
  const [place, setPlace] = useState<Placement>(keyHint?.in ?? "header");
  const [name, setName] = useState(keyHint?.name ?? "");
  const [value, setValue] = useState("");
  const [saveAnyway, setSaveAnyway] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const keyFilled = name.trim() !== "" && value.trim() !== "";
  const keyMissing = withKey && keyAsked && !keyFilled;

  async function sign(walletId: string) {
    try {
      setPhase({ kind: "working", walletId, text: "Connecting to your wallet…" });
      const { api, addressHex } = await connectWallet(walletId);
      setPhase({ kind: "working", walletId, text: "Getting the message to sign…" });
      const challenge = await postJson<Challenge>(`/api/act/${token}/challenge`, { address: addressHex });
      setPhase({ kind: "working", walletId, text: "Approve this message in your wallet. It costs nothing and moves no funds.", message: challenge.message });
      const sig = await signText(api, addressHex, challenge.message);
      setPhase({ kind: "working", walletId, text: "Signature received. Checking it…" });
      const upstreamAuth = withKey && keyFilled ? { in: place, name: name.trim(), value: withPrefix(value, keyHint?.prefix) } : undefined;
      await postJson(`/api/act/${token}`, {
        address: addressHex, ...sig,
        ...(challenge.kind === "wallet" ? { challengeId: challenge.challengeId } : { nonceToken: challenge.nonceToken }),
        ...(upstreamAuth ? { upstreamAuth, saveAnyway } : {}),
      });
      setValue("");
      setPhase({ kind: "done", text: DONE_TEXT });
      // Closes the tab when the browser allows it (a tab a script opened); otherwise the text says to.
      window.setTimeout(() => window.close(), 1500);
    } catch (e) {
      if (needsAnotherClick(e)) setPhase({ kind: "again", text: e.message });
      else if (e instanceof RequestError) setPhase({ kind: "error", text: e.message, keyRefused: e.code === "KEY_REFUSED" });
      else setPhase({ kind: "error", text: walletErrorMessage(e) });
    }
  }

  if (phase.kind === "done") {
    return (
      <div role="status" data-testid="act-done" className="space-y-2 rounded-[2px] border-2 border-ink border-l-8 border-l-mint bg-frost p-5 text-body">
        <p className="font-semibold">{phase.text}</p>
      </div>
    );
  }

  const busy = phase.kind === "working";
  return (
    <div className="space-y-5">
      <h1 className="text-h font-medium">{title}</h1>
      <p className="text-body">
        Sign with the wallet ending <code>{wallet}</code>. Signing costs nothing and moves no funds.
      </p>

      {keyOffered && (
        <fieldset className="space-y-3 rounded-[2px] border-2 border-ink bg-frost p-4" aria-label="Your API's key">
          {!keyAsked && (
            <label className="flex items-center gap-2 text-body">
              <input type="checkbox" checked={withKey} onChange={(e) => setWithKey(e.target.checked)} disabled={busy} />
              My API needs a key
            </label>
          )}
          {withKey && (
            <div className="space-y-3">
              <p className="text-caption text-graphite">
                Sealed so only the Hirakumi gateway can read it. Never paste it in a Sokosumi comment.
              </p>
              <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
                <label className="space-y-1 text-caption">
                  <span className="font-semibold uppercase">Sent as</span>
                  <select className="h-10 w-full rounded-[2px] border-2 border-ink bg-frost px-2 text-body" value={place}
                    onChange={(e) => setPlace(e.target.value as Placement)} disabled={busy}>
                    <option value="header">Header</option>
                    <option value="query">Query parameter</option>
                  </select>
                </label>
                <label className="space-y-1 text-caption">
                  <span className="font-semibold uppercase">Name</span>
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="X-API-Key" disabled={busy} />
                </label>
              </div>
              <label className="block space-y-1 text-caption">
                <span className="font-semibold uppercase">Key{keyHint?.prefix ? ` (we add "${keyHint.prefix.trim()}" in front)` : ""}</span>
                <Input type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} disabled={busy} />
              </label>
              {phase.kind === "error" && phase.keyRefused && (
                <label className="flex items-center gap-2 text-body">
                  <input type="checkbox" checked={saveAnyway} onChange={(e) => setSaveAnyway(e.target.checked)} />
                  Save it anyway
                </label>
              )}
            </div>
          )}
        </fieldset>
      )}

      {wallets === null ? (
        <div role="status" aria-label="Looking for wallets" className="grid gap-3">
          <Skeleton className="h-12 w-full" />
        </div>
      ) : wallets.length === 0 ? (
        <div className="space-y-3">
          {!mobile && <PhoneWalletConnect onConnected={(id) => void sign(id)} />}
          <GetAWallet />
        </div>
      ) : (
        <ul className="grid gap-3" aria-label="Wallets in this browser">
          {wallets.map((w) => (
            <li key={w.id}>
              <Button className="w-full justify-start gap-3" pending={busy && phase.walletId === w.id} disabled={busy || keyMissing}
                onClick={() => void sign(w.id)}>
                {!(busy && phase.walletId === w.id) && <WalletIcon icon={w.icon} />}
                <span>{walletAction("Sign", w)}</span>
              </Button>
            </li>
          ))}
          {!mobile && <li><PhoneWalletConnect onConnected={(id) => void sign(id)} /></li>}
        </ul>
      )}
      {wallets && onlyEmailWallet(wallets) && <GetAWallet title={BROWSER_WALLET_TOO} />}
      {keyMissing && <p className="text-caption text-graphite">Type the key first.</p>}
      {phase.kind === "working" && (
        <div role="status" aria-live="polite" className="space-y-2">
          <InlineStatus busy>{phase.text} <Elapsed prefix=" " className="text-graphite" /></InlineStatus>
          {phase.message && <pre className="whitespace-pre-wrap rounded-[2px] bg-ink p-3 text-caption text-cream">{phase.message}</pre>}
        </div>
      )}
      {phase.kind === "again" && <InlineStatus>{phase.text}</InlineStatus>}
      {phase.kind === "error" && <InlineError>{phase.text}</InlineError>}
    </div>
  );
}
