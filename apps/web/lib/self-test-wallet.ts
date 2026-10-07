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

const buyUrl = (t: SelfPayTarget) =>
  `${t.gatewayBase.replace(/\/+$/, "")}/a/${encodeURIComponent(t.apiId)}/packs/${encodeURIComponent(t.packId)}/buy`;

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

/** Step 2: the signed payment goes to the gateway through x402. Returns the pack's token (server-side only). */
export async function paySelfPayment(
  d: Pick<SelfPayDeps, "fetchImpl">, t: SelfPayTarget, signed: { tx: string; witnessSet: string; nonce: string; priceMicros: string },
): Promise<SelfPayResult> {
  const doFetch = d.fetchImpl ?? fetch;
  let transaction: string;
  try {
    transaction = Buffer.from(Transaction.addVKeyWitnessesHex(signed.tx, signed.witnessSet), "hex").toString("base64");
  } catch {
    throw new SelfPayError(400, "Your wallet's signature couldn't be read. Try again.");
  }
  const { offer } = await readOffer(doFetch, t);
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
  let headers: Record<string, string>;
  try {
    headers = http.encodePaymentSignatureHeader(await http.createPaymentPayload(offer));
  } catch {
    throw new SelfPayError(409, "The pack's price changed since you signed. Nothing was paid. Start again.");
  }
  let res: Response;
  try {
    res = await doFetch(buyUrl(t), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", accept: "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new SelfPayError(502, "Lost the connection while the payment settled. If it went through, the credits show up when you reload.");
  }
  const body = (await res.json().catch(() => null)) as { token?: unknown; credits?: unknown; error?: unknown; message?: unknown } | null;
  let txHash: string | null = null;
  try { txHash = http.getPaymentSettleResponse((n) => res.headers.get(n))?.transaction ?? null; } catch { txHash = null; }
  if (res.ok && typeof body?.token === "string" && typeof body.credits === "number") {
    return { token: body.token, credits: body.credits, txHash, pending: false };
  }
  // No recovery secret was sent, so a payment that didn't confirm in time comes back with its pending token.
  if (res.status === 402 && body?.error === "settlement_failed" && typeof body.token === "string") {
    return { token: body.token, credits: typeof body.credits === "number" ? body.credits : 0, txHash, pending: true };
  }
  const message = typeof body?.message === "string" ? body.message : `The payment failed (HTTP ${res.status}). Nothing was bought.`;
  throw new SelfPayError(res.status >= 400 ? res.status : 502, message);
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
