import { USDM_PREPROD_ASSET } from "@x402/cardano";
import { activateTokenById, listPendingPayments, revokePendingToken, type Sql } from "@hirakumi/db";

/**
 * An x402 Cardano payment is valid for at most maxTimeoutSeconds (600 s) after it is signed. A pending payment
 * still not on-chain an hour later can never land; revoke it so dead rows don't fill the oldest-first queue.
 */
const PENDING_EXPIRY_SECONDS = 3600;

export type ChainOutput = { address: string; amount: Array<{ unit: string; quantity: string }> };
export type ChainLookup = (txHash: string) => Promise<{ found: false } | { found: true; outputs: ChainOutput[] }>;

export const BLOCKFROST_PREPROD = "https://cardano-preprod.blockfrost.io/api/v0";
export const USDM_PREPROD_UNIT = USDM_PREPROD_ASSET.replace(".", "");

export function blockfrostLookup(projectId: string, baseUrl: string = BLOCKFROST_PREPROD, fetchImpl: typeof fetch = fetch): ChainLookup {
  return async (txHash) => {
    const res = await fetchImpl(`${baseUrl}/txs/${txHash}/utxos`, { headers: { project_id: projectId } });
    if (res.status === 404) return { found: false };
    if (!res.ok) throw new Error(`Blockfrost answered ${res.status} for ${txHash}`);
    const body = (await res.json()) as { outputs: ChainOutput[] };
    return { found: true, outputs: body.outputs.map((o) => ({ address: o.address, amount: o.amount })) };
  };
}

export function paidTo(outputs: ChainOutput[], address: string, unit: string): bigint {
  let total = 0n;
  for (const o of outputs) {
    if (o.address !== address) continue;
    for (const a of o.amount) if (a.unit === unit) total += BigInt(a.quantity);
  }
  return total;
}

export class Reconciler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly minAgeSeconds: number;
  private readonly intervalMs: number;
  constructor(private readonly d: { sql: Sql; lookup: ChainLookup; minAgeSeconds?: number; intervalMs?: number }) {
    this.minAgeSeconds = d.minAgeSeconds ?? 120;
    this.intervalMs = d.intervalMs ?? 60_000;
  }

  start(): void {
    this.timer = setInterval(() => { void this.tick().catch((e) => console.error("[reconcile]", e)); }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<{ checked: number; activated: number }> {
    if (this.running) return { checked: 0, activated: 0 };
    this.running = true;
    let checked = 0;
    let activated = 0;
    try {
      for (const p of await listPendingPayments(this.d.sql, this.minAgeSeconds)) {
        checked += 1;
        let r: Awaited<ReturnType<ChainLookup>>;
        try {
          r = await this.d.lookup(p.tx_hash);
        } catch (e) {
          // One failed lookup (a Blockfrost error) must not stop the rest of the queue; this row is retried next tick.
          console.error(`[reconcile] lookup ${p.tx_hash}:`, (e as Error).message);
          continue;
        }
        if (!r.found) {
          if (p.age_seconds > PENDING_EXPIRY_SECONDS && (await revokePendingToken(this.d.sql, p.id))) {
            console.log(`[reconcile] token ${p.id} revoked: tx ${p.tx_hash} never reached the chain`);
          }
          continue;
        }
        const paid = paidTo(r.outputs, p.pay_to, USDM_PREPROD_UNIT);
        if (paid >= BigInt(p.price_micros)) {
          if (await activateTokenById(this.d.sql, p.id)) {
            activated += 1;
            console.log(`[reconcile] token ${p.id} activated from chain tx ${p.tx_hash}`);
          }
        } else {
          console.warn(`[reconcile] tx ${p.tx_hash} pays ${paid} of ${p.price_micros} to the seller; token ${p.id} stays pending`);
        }
      }
    } finally {
      this.running = false;
    }
    return { checked, activated };
  }
}
