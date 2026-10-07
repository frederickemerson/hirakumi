import { createHash, createHmac } from "node:crypto";
import { Address, Assets, Client, preprod, Transaction } from "@evolution-sdk/evolution";
import { parseAssetUnit, USDM_PREPROD_ASSET, type ClientCardanoSigner } from "@x402/cardano";
import { ExactCardanoScheme } from "@x402/cardano/exact/client";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";

/**
 * A seller paying for a pack of their own API from their browser wallet (CIP-30), in two steps:
 * 1. prepare: read the gateway's 402 for the pack, exactly as any agent does, and build the unsigned payment
 *    from the wallet's own UTxOs (the server has the Blockfrost key for protocol parameters).
 * 2. pay: the wallet signed it in the browser (signTx, partial); add its witnesses and pay the gateway with x402.
 * The request carries no escrow headers, so a hybrid gateway settles it direct: the money goes to the seller's
 * own payout address and only the network fee is spent. The token comes back to the server, never the browser.
 */

export const NETWORK = "cardano:preprod";
const TIMEOUT_MS = 110_000;

export class SelfPayError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export type SelfPayTarget = {
  gatewayBase: string;
  apiId: string;
  packId: string;
  /** The API's payout address (the seller's): a direct pack pays it. */
  payTo: string;
};

export type UnsignedPayment = { tx: string; nonce: string; feeLovelace: string };

/** Builds the unsigned payment. Injected so tests run without a chain; the default uses Evolution + Blockfrost. */
export type BuildPayment = (a: {
  utxos: string[]; changeAddress: string; payTo: string; asset: string; amount: bigint; ttlMs: bigint;
}) => Promise<UnsignedPayment>;

export type SelfPayDeps = { fetchImpl?: typeof fetch; build: BuildPayment; now?: () => number };

export type PreparedPayment = UnsignedPayment & { priceMicros: string; calls: number | null; payTo: string };

const packUrl = (t: SelfPayTarget) =>
  `${t.gatewayBase.replace(/\/+$/, "")}/a/${encodeURIComponent(t.apiId)}/packs/${encodeURIComponent(t.packId)}`;
const buyUrl = (t: SelfPayTarget) => `${packUrl(t)}/buy`;

/** The gateway's 402 for this pack, and the one requirement we pay: exact, preprod tUSDM, to the seller. */
async function readOffer(doFetch: typeof fetch, t: SelfPayTarget): Promise<{ offer: PaymentRequired; req: PaymentRequirements; calls: number | null }> {
  let res: Response;
  try {
    res = await doFetch(buyUrl(t), {
      method: "POST",
      // No X-Hirakumi-Receipt-Key / Refund-Address / Settlement: a plain buyer, which hybrid settles direct.
      headers: { "content-type": "application/json", accept: "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new SelfPayError(502, "We couldn't reach the Hirakumi gateway. Try again in a minute.");
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.status === 400 && body?.error === "receipt_key_required") {
    throw new SelfPayError(409, "This gateway sells packs in escrow only, so a self test can't settle direct. Your free test still works; for more, Hirakumi has to run the gateway in hybrid mode.");
  }
  if (res.status !== 402) {
    const message = typeof body?.message === "string" ? body.message : `The gateway answered HTTP ${res.status} instead of a price.`;
    throw new SelfPayError(res.status >= 400 && res.status < 600 ? res.status : 502, message);
  }
  const http = new x402HTTPClient(new x402Client());
  let offer: PaymentRequired;
  try {
    offer = http.getPaymentRequiredResponse((n) => res.headers.get(n), body);
  } catch {
    throw new SelfPayError(502, "The gateway's price offer couldn't be read.");
  }
  const req = offer.accepts.find((r) => r.scheme === "exact" && r.network === NETWORK && r.asset === USDM_PREPROD_ASSET);
  if (!req) throw new SelfPayError(502, "The gateway offered no tUSDM payment on preprod.");
  if (req.payTo !== t.payTo) {
    // Escrow: the money would lock at the pack escrow instead of reaching you. Never pay that as a self test.
    throw new SelfPayError(409, "The gateway offered escrow for this pack, not a direct payment to you, so nothing was paid. Try again later.");
  }
  const calls = typeof (req.extra as { calls?: unknown } | undefined)?.calls === "number" ? (req.extra as { calls: number }).calls : null;
  return { offer, req, calls };
}

/** Step 1: the price from the gateway and the unsigned payment for the wallet to sign. */
export async function prepareSelfPayment(
  d: SelfPayDeps, t: SelfPayTarget, wallet: { utxos: string[]; changeAddress: string },
): Promise<PreparedPayment> {
  const { req, calls } = await readOffer(d.fetchImpl ?? fetch, t);
  const now = d.now ?? Date.now;
  let built: UnsignedPayment;
  try {
    built = await d.build({
      utxos: wallet.utxos, changeAddress: wallet.changeAddress, payTo: req.payTo, asset: req.asset,
      amount: BigInt(req.amount), ttlMs: BigInt(now()) + BigInt(req.maxTimeoutSeconds) * 1000n,
    });
  } catch (e) {
    console.warn(`[self-test] building ${t.apiId}'s payment failed: ${(e as Error)?.message ?? String(e)}`);
    throw new SelfPayError(422, "We couldn't build the payment from your wallet. It needs the pack's price in tUSDM plus about 2 tADA on preprod. Nothing was paid.");
  }
  return { ...built, priceMicros: req.amount, calls, payTo: req.payTo };
}

export type SelfPayResult = { token: string; credits: number; txHash: string | null; pending: boolean };
/**
 * bought: the gateway gave the pack's token (pending: its payment is still confirming on-chain). pending: the
 * payment may have left and nothing confirms it yet; resumeSelfPayment asks again. A certain failure throws.
 */
export type SelfPayOutcome = ({ kind: "bought" } & SelfPayResult) | { kind: "pending" };
export type SignedPayment = { tx: string; witnessSet: string; nonce: string; priceMicros: string };

export const SELF_PAY_PENDING = "Your payment is sent and waiting for Cardano to confirm it. It goes to your own payout address either way.";

/**
 * The recovery secret for one payment, derived (not stored): HMAC of the payment's nonce (the UTxO it spends,
 * unique per payment) under the server's key. Its sha256 goes with the payment as X-Hirakumi-Recovery, so the
 * token of a payment whose answer was lost can always be fetched again from /recover, by this server only.
 */
export function selfPayRecoverySecret(key: string, t: SelfPayTarget, nonce: string): string {
  return createHmac("sha256", key).update(`hirakumi-self-pay\n${t.apiId}\n${t.packId}\n${nonce}`).digest("hex");
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** The PAYMENT-SIGNATURE header for the transaction the wallet signed, answering `offer`. */
async function paymentHeader(t: SelfPayTarget, offer: PaymentRequired, signed: SignedPayment): Promise<Record<string, string>> {
  let transaction: string;
  try {
    transaction = Buffer.from(Transaction.addVKeyWitnessesHex(signed.tx, signed.witnessSet), "hex").toString("base64");
  } catch {
    throw new SelfPayError(400, "Your wallet's signature couldn't be read. Try again.");
  }
  // The signer only hands over the transaction the seller signed, and only for the offer it was built for.
  const signer: ClientCardanoSigner = {
    getAddress: () => t.payTo,
    buildAndSignPaymentTransaction: (input) => {
      if (input.payTo !== t.payTo || input.asset !== USDM_PREPROD_ASSET || input.amount !== signed.priceMicros) {
        throw new Error("the price changed since you signed");
      }
      return { transaction, nonce: signed.nonce };
    },
  };
  const client = new x402Client()
    .setSpendControls({ allowedAssets: [{ network: NETWORK, asset: USDM_PREPROD_ASSET, maxAmountPerPayment: signed.priceMicros }] })
    .register("cardano:*", new ExactCardanoScheme(signer));
  const http = new x402HTTPClient(client);
  try {
    return http.encodePaymentSignatureHeader(await http.createPaymentPayload(offer));
  } catch {
    throw new SelfPayError(409, "The pack's price changed since you signed. Nothing was paid. Start again.");
  }
}

/** The offer the seller signed for, rebuilt locally: /recover reads only the transaction from the header. */
function signedOffer(t: SelfPayTarget, signed: SignedPayment): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: buyUrl(t), description: "pack", mimeType: "application/json" },
    accepts: [{ scheme: "exact", network: NETWORK, asset: USDM_PREPROD_ASSET, amount: signed.priceMicros, payTo: t.payTo, maxTimeoutSeconds: 600, extra: {} }],
  } as PaymentRequired;
}

/**
 * Asks /recover for the token of a payment whose answer was lost. 404 means Hirakumi never received it: final
 * only when `notReceivedIsFinal` (on the first ask right after a dropped connection it may still be arriving).
 */
async function recoverSelfPayment(
  doFetch: typeof fetch, t: SelfPayTarget, headers: Record<string, string>, secret: string, notReceivedIsFinal: boolean,
): Promise<SelfPayOutcome> {
  let res: Response;
  try {
    res = await doFetch(`${packUrl(t)}/recover`, {
      method: "POST",
      headers: { ...headers, "x-hirakumi-recovery-secret": secret, accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { kind: "pending" };
  }
  const body = (await res.json().catch(() => null)) as { token?: unknown; credits?: unknown; status?: unknown } | null;
  if (res.ok && typeof body?.token === "string" && typeof body.credits === "number") {
    return { kind: "bought", token: body.token, credits: body.credits, txHash: null, pending: body.status === "pending" };
  }
  if (res.status === 404 && notReceivedIsFinal) throw new SelfPayError(410, "Hirakumi never received the payment, so nothing was paid.");
  return { kind: "pending" };
}

/** Step 2: the signed payment goes to the gateway through x402. The pack's token stays server-side. */
export async function paySelfPayment(
  d: Pick<SelfPayDeps, "fetchImpl">, t: SelfPayTarget, signed: SignedPayment, recoverySecret: string,
): Promise<SelfPayOutcome> {
  const doFetch = d.fetchImpl ?? fetch;
  const { offer } = await readOffer(doFetch, t);
  const headers = await paymentHeader(t, offer, signed);
  let res: Response;
  try {
    res = await doFetch(buyUrl(t), {
      method: "POST",
      headers: { ...headers, "x-hirakumi-recovery": sha256(recoverySecret), "content-type": "application/json", accept: "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // The payment may have left: the outcome is unknown, never a failure.
    return recoverSelfPayment(doFetch, t, headers, recoverySecret, false);
  }
  const body = (await res.json().catch(() => null)) as { token?: unknown; credits?: unknown; error?: unknown; message?: unknown } | null;
  let txHash: string | null = null;
  try { txHash = new x402HTTPClient(new x402Client()).getPaymentSettleResponse((n) => res.headers.get(n))?.transaction ?? null; } catch { txHash = null; }
  if (res.ok && typeof body?.token === "string" && typeof body.credits === "number") {
    return { kind: "bought", token: body.token, credits: body.credits, txHash, pending: false };
  }
  // Settlement not confirmed in time (it may still land), the answer lost at a proxy, or the payment already used
  // by an earlier try: none of these says nothing was paid, so the token is fetched from /recover.
  if ((res.status === 402 && body?.error === "settlement_failed") || res.status === 502 || res.status === 504
    || (res.status === 409 && body?.error === "payment_already_used")) {
    const r = await recoverSelfPayment(doFetch, t, headers, recoverySecret, false);
    return r.kind === "bought" ? { ...r, txHash: r.txHash ?? txHash } : r;
  }
  // Refused before settlement (the payment was invalid, the API is Down, or the gateway failed first): final.
  const message = typeof body?.message === "string" ? body.message : `The payment failed (HTTP ${res.status}). Nothing was bought.`;
  throw new SelfPayError(res.status >= 400 ? res.status : 502, message);
}

/** A pending payment, asked again: never pays, only reads /recover for the payment the seller signed. */
export async function resumeSelfPayment(
  d: Pick<SelfPayDeps, "fetchImpl">, t: SelfPayTarget, signed: SignedPayment, recoverySecret: string,
): Promise<SelfPayOutcome> {
  const headers = await paymentHeader(t, signedOffer(t, signed), signed);
  return recoverSelfPayment(d.fetchImpl ?? fetch, t, headers, recoverySecret, true);
}

/** A CIP-30 wallet that only exists on the server: it hands Evolution the browser wallet's UTxOs and address. */
function readOnlyCip30(utxos: string[], changeAddress: string) {
  const refuse = async (): Promise<never> => { throw new Error("signing happens in your browser wallet"); };
  return {
    getUsedAddresses: async () => [changeAddress],
    getUnusedAddresses: async () => [] as string[],
    getRewardAddresses: async () => [] as string[],
    getUtxos: async () => utxos,
    signTx: refuse,
    signData: refuse,
    submitTx: refuse,
  };
}

/**
 * The default builder, the same transaction @x402/cardano's own signer builds (toClientCardanoSigner): one wallet
 * UTxO as the nonce input, the exact amount to payTo, TTL from maxTimeoutSeconds, change back to the wallet.
 */
export function evolutionBuilder(blockfrost: { baseUrl: string; projectId: string }): BuildPayment {
  return async (a) => {
    if (a.utxos.length === 0) throw new Error("no UTxOs in the wallet");
    const client = Client.make(preprod).withBlockfrost(blockfrost).withCip30(readOnlyCip30(a.utxos, a.changeAddress) as never);
    const utxos = await client.getWalletUtxos();
    const nonceUtxo = utxos[0];
    if (!nonceUtxo) throw new Error("no UTxOs in the wallet");
    const nonce = `${Buffer.from(nonceUtxo.transactionId.hash).toString("hex")}#${Number(nonceUtxo.index)}`;
    const { policyId, assetNameHex } = parseAssetUnit(a.asset);
    const built = await client.newTx()
      .collectFrom({ inputs: [nonceUtxo] })
      .payToAddress({ address: Address.fromBech32(a.payTo), assets: Assets.addByHex(Assets.zero, policyId, assetNameHex, a.amount) })
      .setValidity({ to: a.ttlMs })
      .build({ changeAddress: await client.address(), autoMinUtxo: true });
    const tx = await built.toTransaction();
    return { tx: Transaction.toCBORHex(tx), nonce, feeLovelace: tx.body.fee.toString() };
  };
}
