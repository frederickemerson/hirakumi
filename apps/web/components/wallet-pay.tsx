"use client";

import { useState } from "react";
import { PhoneWalletConnect } from "@/components/phone-wallet-connect";
import { InlineError } from "@/components/states";
import type { TryPackView } from "@/components/try-console";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { GetAWallet, MobileNote, useIsMobile, useWallets, WalletIcon } from "@/components/wallet-picker";
import { postJson } from "@/lib/client-fetch";
import { formatTusdm } from "@/lib/money";
import { connectWallet, WalletError, walletErrorMessage, type Cip30Api } from "@/lib/wallet-client";
import { useElapsed } from "@/components/elapsed";

/** CIP-30 calls a payment needs on top of sign-in's. */
type PayingApi = Cip30Api & {
  getUtxos?(): Promise<string[] | undefined>;
  signTx?(tx: string, partialSign: boolean): Promise<string>;
};

type Prepared = { tx: string; nonce: string; feeLovelace: string; priceMicros: string; calls: number | null };
type Paid = { credits: number; txHash: string | null; pending: boolean };

type Phase =
  | { kind: "idle" }
  | { kind: "working"; walletId: string; text: string }
  | { kind: "paying"; walletId: string; startedAt: number; text: string }
  | { kind: "error"; text: string };

export const SELF_PAY_LINE = "You pay your own API. The money comes back to you; you only pay the network fee.";

const tada = (lovelace: string) => (Number(lovelace) / 1_000_000).toFixed(2);

/** CIP-30 TxSignError: 1 the wallet couldn't sign, 2 the person declined. */
function signErrorMessage(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === 2) return "You declined the payment in your wallet. Nothing was paid.";
  if (code === 1) return "Your wallet couldn't sign this payment. Nothing was paid.";
  return walletErrorMessage(e);
}

/**
 * The seller pays for a pack of their own API from their browser wallet: the server reads the gateway's price
 * and builds the payment, the wallet signs it here, the server pays the gateway with it (direct settlement, to
 * the seller's own payout address). The pack's token never reaches the browser.
 */
export function WalletPay({ apiId, packPrice, onBought }: {
  apiId: string;
  packPrice: { calls: number; priceMicros: string } | null;
  onBought: (pack: TryPackView) => void;
}) {
  const wallets = useWallets();
  const mobile = useIsMobile();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const base = `/api/apis/${encodeURIComponent(apiId)}/try/pay`;

  async function pay(walletId: string) {
    let stage: "wallet" | "sign" = "wallet";
    try {
      setPhase({ kind: "working", walletId, text: "Connecting to your wallet…" });
      const { api } = await connectWallet(walletId);
      const w = api as PayingApi;
      if (typeof w.getUtxos !== "function" || typeof w.signTx !== "function") {
        throw new WalletError("This wallet can't sign payments here. Try another wallet.");
      }
      const utxos = (await w.getUtxos()) ?? [];
      if (utxos.length === 0) throw new WalletError("Your wallet has no funds on preprod. Get test ADA and tUSDM, then try again.");
      setPhase({ kind: "working", walletId, text: "Getting the price from Hirakumi…" });
      const p = await postJson<Prepared>(`${base}/prepare`, { utxos, changeAddress: await api.getChangeAddress() });
      setPhase({
        kind: "working", walletId,
        text: `Approve in your wallet: ${formatTusdm(p.priceMicros)} tUSDM to your own address, network fee ${tada(p.feeLovelace)} tADA.`,
      });
      stage = "sign";
      const witnessSet = await w.signTx(p.tx, true);
      stage = "wallet";
      setPhase({ kind: "paying", walletId, startedAt: Date.now(), text: "Settling on Cardano. This takes 20 to 60 s." });
      const r = await postJson<Paid>(base, { tx: p.tx, witnessSet, nonce: p.nonce, priceMicros: p.priceMicros });
      setPhase({ kind: "idle" });
      onBought({ credits: r.credits, txHash: r.txHash, pending: r.pending });
    } catch (e) {
      setPhase({ kind: "error", text: stage === "sign" ? signErrorMessage(e) : walletErrorMessage(e) });
    }
  }

  const busy = phase.kind === "working" || phase.kind === "paying";
  return (
    <div id="try-pack-note" role="note" className="space-y-4" data-testid="wallet-pay">
      <div className="space-y-1">
        <p className="text-body-lg font-semibold">Pay with your wallet</p>
        {packPrice && (
          <p className="text-body">
            {`${formatTusdm(packPrice.priceMicros)} tUSDM for ${packPrice.calls} calls, paid to your payout address. Settled direct, no escrow.`}
          </p>
        )}
      </div>
      {mobile && <MobileNote />}
      {wallets === null ? (
        <Skeleton className="h-12 w-full" />
      ) : wallets.length === 0 ? (
        <GetAWallet />
      ) : (
        <ul className="space-y-2">
          {wallets.map((w) => {
            const mine = (phase.kind === "working" || phase.kind === "paying") && phase.walletId === w.id;
            return (
              <li key={w.id}>
                <Button type="button" size="lg" variant={mine ? "default" : "outline"} disabled={busy} aria-busy={mine || undefined}
                  className="w-full justify-start gap-3" onClick={() => void pay(w.id)}>
                  {mine ? <Spinner className="size-3" /> : <WalletIcon icon={w.icon} />}
                  {`Pay with ${w.name}`}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {!busy && <PhoneWalletConnect />}
      {phase.kind === "working" && <p role="status" aria-live="polite" className="border-l-4 border-sky pl-3 text-body">{phase.text}</p>}
      {phase.kind === "paying" && <Paying startedAt={phase.startedAt} text={phase.text} />}
      {phase.kind === "error" && <InlineError>{phase.text}</InlineError>}
    </div>
  );
}

function Paying({ startedAt, text }: { startedAt: number; text: string }) {
  const s = useElapsed(startedAt);
  return (
    <p role="status" aria-live="polite" className="flex items-center gap-2 border-l-4 border-sky pl-3 text-body">
      <Spinner className="size-3" />
      <span className="flex-1">{text}</span>
      {s !== null && <span className="tabular-nums text-caption text-graphite">{`${s} s`}</span>}
    </p>
  );
}
