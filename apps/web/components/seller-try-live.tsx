"use client";

import { useState } from "react";
import { TryConsole, type TryOp, type TryPackView } from "@/components/try-console";
import { WalletPay } from "@/components/wallet-pay";

/**
 * The seller's own Try it live: the same console as the public one, against /api/apis/[apiId]/try. The first
 * pack is the free test (Hirakumi's demo wallet); once that is used, the seller's wallet pays.
 */
export function SellerTryLive({ apiId, ops, initialPack, packPrice, downReason, freeTest, freeTestsLeft }: {
  apiId: string;
  ops: TryOp[];
  initialPack: TryPackView | null;
  packPrice: { calls: number; priceMicros: string } | null;
  downReason: string | null;
  /** This listing's free test is still available to this seller. */
  freeTest: boolean;
  freeTestsLeft: number;
}) {
  const [free, setFree] = useState(freeTest);
  const [pack, setPack] = useState(initialPack);
  // A wallet purchase remounts the console with its new pack.
  const [generation, setGeneration] = useState(0);
  const base = `/api/apis/${encodeURIComponent(apiId)}/try`;

  return (
    <TryConsole
      key={generation}
      apiId={apiId}
      ops={ops}
      initialPack={pack}
      packPrice={packPrice}
      downReason={downReason}
      liveBuy={free}
      buyLabel={free ? "Run your free test" : undefined}
      paths={{ call: base, buy: `${base}/free` }}
      onPackChange={(p) => {
        setPack(p);
        if (p) setFree(false);
      }}
      buyNote={
        <>
          Free: Hirakumi&apos;s demo wallet pays for this pack. One free test per API
          {` (${freeTestsLeft} left on your account)`}. It settles in 20 to 60 s on Cardano preprod, then makes your call.
        </>
      }
      noPackHint="Pay for a pack with your wallet, then call your API."
      noPackNote={
        <WalletPay
          apiId={apiId}
          packPrice={packPrice}
          onBought={(p) => {
            setPack(p);
            setFree(false);
            setGeneration((g) => g + 1);
          }}
        />
      }
    />
  );
}
