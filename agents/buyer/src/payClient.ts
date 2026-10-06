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
export type EscrowPurchase = PackPurchase & { channelId: string; channelUrl: string | null };

/** Called with the offer x402 is about to pay; throw to refuse (the payment is never signed). */
export type OfferCheck = (requirements: { scheme: string; network: string; asset: string; amount: string; payTo: string; extra?: Record<string, unknown> }) => void;

/** Called with the signed payment and the recovery secret, before the payment is sent. */
export type SignedHook = (saved: { paymentSignature: string; recoverySecret: string }) => void | Promise<void>;

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

/** The escrow purchase failed before any payment was signed: nothing can land on-chain. */
export class PaymentNotSentError extends Error {
  constructor(cause: unknown) {
    super(`Pack purchase failed before any payment was signed: ${(cause as Error)?.message ?? String(cause)}`, { cause });
  }
}

/** Direct packs: pay only the exact amount of the pack we chose, in tUSDM, as a plain transfer. */
export function directPackCheck(expected: { amount: bigint }): OfferCheck {
  return (req) => {
    if (req.scheme !== "exact" || req.network !== "cardano:preprod") throw new Error(`refusing to pay: unexpected scheme/network ${req.scheme} ${req.network}`);
    if (req.asset !== USDM_PREPROD_ASSET) throw new Error(`refusing to pay: asset ${req.asset} is not tUSDM`);
    if (req.amount !== expected.amount.toString()) throw new Error(`refusing to pay: amount ${req.amount} is not the chosen pack's price ${expected.amount}`);
    if (req.extra?.assetTransferMethod === "script") throw new Error("refusing to pay: a direct pack must not lock funds at a script");
  };
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
  // Every purchase installs a check here: it sees the exact requirements before anything is signed.
  let offerCheck: OfferCheck | null = null;
  client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
    if (!offerCheck) return;
    try {
      offerCheck(selectedRequirements as Parameters<OfferCheck>[0]);
    } catch (e) {
      return { abort: true, reason: (e as Error).message };
    }
  });
  // Keep the signed payment: if settlement times out it may still land on-chain, and /recover needs it.
  let lastSignature: string | null = null;
  // The current purchase's "payment signed, now settling" listener (set per purchase, like offerCheck).
  let onSigned: ((paymentSignature: string) => void | Promise<void>) | null = null;
  client.onAfterPaymentCreation(async ({ paymentPayload }) => {
    lastSignature = encodePaymentSignatureHeader(paymentPayload);
    // Awaited before the payment is sent, so a caller can store what /recover needs first.
    try { await onSigned?.(lastSignature); } catch { /* a progress listener must never break a payment */ }
  });
  // Look the global fetch up per request (not once at creation), so a replaced/instrumented fetch is honoured.
  const payFetch = wrapFetchWithPayment((input, init) => globalThis.fetch(input, init), client);
  const http = new x402HTTPClient(client);
  const serial = new SerialPayer();

  return {
    address,
    /**
     * Escrow pack: sends our IOU key and refund address on both the unpaid and the paid request, and pays only
     * if `check` accepts the 402's datum.
     */
    buyEscrowPack(buyUrl: string, keys: { receiptKey: string; refundAddress: string }, check: OfferCheck): Promise<EscrowPurchase> {
      return serial.run(async () => {
        lastSignature = null;
        offerCheck = check;
        const recoverySecret = randomBytes(32).toString("base64url");
        try {
          const res = await payFetch(buyUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json", accept: "application/json",
              "x-hirakumi-receipt-key": keys.receiptKey, "x-hirakumi-refund-address": keys.refundAddress,
              "x-hirakumi-recovery": createHash("sha256").update(recoverySecret).digest("hex"),
            },
            body: "{}",
          });
          const text = await res.text();
          if (!res.ok) throw new PackPurchaseError(res.status, text, lastSignature, recoverySecret);
          const body = JSON.parse(text) as { token?: unknown; credits?: unknown; apiId?: unknown; channelId?: unknown; channelUrl?: unknown };
          if (typeof body.token !== "string" || typeof body.credits !== "number" || typeof body.apiId !== "string" || typeof body.channelId !== "string") {
            throw new PackPurchaseError(res.status, text);
          }
          let txHash: string | null = null;
          try { txHash = http.getPaymentSettleResponse((name) => res.headers.get(name))?.transaction ?? null; } catch { txHash = null; }
          return {
            token: body.token, credits: body.credits, apiId: body.apiId, txHash, channelId: body.channelId,
            channelUrl: typeof body.channelUrl === "string" ? body.channelUrl : null,
          };
        } catch (e) {
          // Nothing was signed, so nothing can land on-chain: the caller may forget the channel.
          if (lastSignature === null) throw new PaymentNotSentError(e);
          throw e;
        } finally {
          offerCheck = null;
        }
      });
    },
    /**
     * Direct pack: pays only `expected.amount` (the chosen pack's price), never just "anything under the cap".
     * `hooks.onSigned` fires once the payment is signed, just before it is sent (settlement on Cardano starts),
     * with what /recover needs. It is awaited, so the caller can persist both before any money moves.
     */
    buyPack(buyUrl: string, expected: { amount: bigint }, hooks: { onSigned?: SignedHook } = {}): Promise<PackPurchase> {
      return serial.run(async () => {
        lastSignature = null;
        offerCheck = directPackCheck(expected);
        // Only its hash travels with the payment; the secret stays here until a recovery needs it.
        const recoverySecret = randomBytes(32).toString("base64url");
        const hook = hooks.onSigned;
        onSigned = hook ? (paymentSignature) => hook({ paymentSignature, recoverySecret }) : null;
        try {
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
        } catch (e) {
          // A signed payment can still land on-chain even when the answer was lost: keep what /recover needs.
          if (!(e instanceof PackPurchaseError) && lastSignature !== null) {
            throw new PackPurchaseError(0, (e as Error)?.message ?? String(e), lastSignature, recoverySecret);
          }
          throw e;
        } finally {
          offerCheck = null;
          onSigned = null;
        }
      });
    },
  };
}
