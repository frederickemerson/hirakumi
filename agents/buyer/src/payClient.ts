import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { createHash, randomBytes } from "node:crypto";
import { toClientCardanoSigner, USDM_PREPROD_ASSET } from "@x402/cardano";
import { ExactCardanoScheme } from "@x402/cardano/exact/client";
import type { SpendControls } from "@x402/core/client";

export function spendControlsFor(maxPackMicros: bigint): SpendControls {
  if (maxPackMicros <= 0n) throw new Error("maxPackMicros must be positive");
  // USDM is a default asset, so without this entry the client applies a $1 cap and refuses a 2 tUSDM pack.
  // Listing only USDM also means lovelace (not a default asset) is never paid.
  return { allowedAssets: [{ network: "cardano:preprod", asset: USDM_PREPROD_ASSET, maxAmountPerPayment: maxPackMicros.toString() }] };
}

/** One wallet, one payment at a time: the Cardano signer uses the first UTxO as the nonce. */
export class SerialPayer {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export type PackPurchase = { token: string; credits: number; apiId: string; txHash: string | null };

export class PackPurchaseError extends Error {
  /**
   * paymentSignature: the signed payment that was sent, when one was; it can still settle on-chain.
   * recoverySecret: proves to /recover that this buyer made the payment (the payment itself is public).
   */
  constructor(readonly status: number, readonly body: string, readonly paymentSignature: string | null = null, readonly recoverySecret: string | null = null) {
    super(`Pack purchase failed: HTTP ${status} ${body.slice(0, 300)}`);
  }
  get settlementFailed(): boolean {
    return this.status === 402 && this.paymentSignature !== null && this.body.includes("settlement_failed");
  }
}

export function createPackPayer(cfg: { mnemonic: string; blockfrostProjectId: string; blockfrostBaseUrl: string; maxPackMicros: bigint }) {
  const client = new x402Client().setSpendControls(spendControlsFor(cfg.maxPackMicros));
  const signer = toClientCardanoSigner({
    mnemonic: cfg.mnemonic,
    network: "cardano:preprod",
    provider: { blockfrost: { baseUrl: cfg.blockfrostBaseUrl, projectId: cfg.blockfrostProjectId } },
  });
  const address = signer.getAddress();
  if (!address.startsWith("addr_test1")) throw new Error(`Buyer wallet ${address} is not a preprod address`);
  client.register("cardano:*", new ExactCardanoScheme(signer));
  // Keep the signed payment: if settlement times out it may still land on-chain, and /recover needs it.
  let lastSignature: string | null = null;
  client.onAfterPaymentCreation(async ({ paymentPayload }) => {
    lastSignature = encodePaymentSignatureHeader(paymentPayload);
  });
  const payFetch = wrapFetchWithPayment(fetch, client);
  const http = new x402HTTPClient(client);
  const serial = new SerialPayer();

  return {
    address,
    buyPack(buyUrl: string): Promise<PackPurchase> {
      return serial.run(async () => {
        lastSignature = null;
        // Only its hash travels with the payment; the secret stays here until a recovery needs it.
        const recoverySecret = randomBytes(32).toString("base64url");
        const res = await payFetch(buyUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json", accept: "application/json",
            "x-hirakumi-recovery": createHash("sha256").update(recoverySecret).digest("hex"),
          },
          body: "{}",
        });
        const text = await res.text();
        if (!res.ok) throw new PackPurchaseError(res.status, text, lastSignature, recoverySecret);
        const body = JSON.parse(text) as { token?: unknown; credits?: unknown; apiId?: unknown };
        if (typeof body.token !== "string" || typeof body.credits !== "number" || typeof body.apiId !== "string") {
          throw new PackPurchaseError(res.status, text);
        }
        let txHash: string | null = null;
        try {
          txHash = http.getPaymentSettleResponse((name) => res.headers.get(name))?.transaction ?? null;
        } catch {
          txHash = null;
        }
        return { token: body.token, credits: body.credits, apiId: body.apiId, txHash };
      });
    },
  };
}
