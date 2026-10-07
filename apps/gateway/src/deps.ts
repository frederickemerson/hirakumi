import type { FacilitatorClient } from "@x402/core/server";
import type { Sql } from "@hirakumi/db";
import type { TxtLookup } from "@hirakumi/core";
import type { EscrowPurchase, OfferCheck, SignedHook } from "@hirakumi/buyer";
import type { GatewayConfig } from "./config";
import type { HealthTracker } from "./health";
import type { EscrowChain } from "./escrowChain";
import type { MasumiPort } from "./masumi-port";
import type { ApiRegistry } from "./registry";

export type AppDeps = {
  sql: Sql;
  config: GatewayConfig;
  registry: ApiRegistry;
  health: HealthTracker;
  facilitator: FacilitatorClient;
  masumi: MasumiPort | null;
  /** The Cardano transaction hash inside an x402 payment payload, or null if it isn't one. Injected by tests. */
  paymentTxHash?: (payload: Record<string, unknown>) => string | null;
  /** PACK_MODE=escrow: reads (and, with an operator key, writes) the chain. Null → locks are verified later. */
  escrowChain?: EscrowChain | null;
  /** TXT lookups for the ownership proof. Unset: the resolvers in config.dnsResolvers. Injected by tests. */
  txtLookup?: TxtLookup;
  /** "Try it live" purchases from Hirakumi's demo buyer wallet. Unset or null: the demo buy route answers 503. */
  demoBuyer?: DemoBuyer | null;
};

/** Hirakumi's demo buyer wallet, built from BUYER_MNEMONIC with the buyer library (agents/buyer). */
export type DemoBuyer = {
  address: string;
  /** Direct-pack x402 purchase that pays exactly `expected.amount`. `onSigned` fires when settlement starts. */
  buyPack(buyUrl: string, expected: { amount: bigint }, hooks?: { onSigned?: SignedHook }): Promise<{ token: string; credits: number; txHash: string | null }>;
  /**
   * Escrow-pack x402 purchase (PACK_MODE=escrow): sends the IOU key and refund address, pays only if `check`
   * accepts the 402's datum, and `onSigned` fires (awaited) once the lock is signed, before it is sent.
   */
  buyEscrowPack(
    buyUrl: string, keys: { receiptKey: string; refundAddress: string }, check: OfferCheck, hooks?: { onSigned?: SignedHook },
  ): Promise<EscrowPurchase>;
  /** What the wallet holds on-chain right now. */
  balance(): Promise<{ lovelace: bigint; usdmMicros: bigint }>;
  /** Used for /recover against the gateway's own public URL. */
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
};
