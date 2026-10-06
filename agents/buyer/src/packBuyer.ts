import { callOperation, choosePack, formatMicros, type CallOutcome, type CreditsRequired, type FetchLike } from "./gatewayClient.js";
import { PackPurchaseError, type PackPurchase } from "./payClient.js";
import type { PendingPayment, PendingStore, TokenStore } from "./tokenStore.js";

export type PackDemoDeps = {
  fetch: FetchLike;
  buyPack: (buyUrl: string, expected: { amount: bigint }) => Promise<PackPurchase>;
  tokens: TokenStore;
  pending: PendingStore;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};
export type PackDemoOptions = {
  gatewayUrl: string; apiId: string; opId: string; query: Record<string, string>; calls: number;
  intervalMs: number; maxPackMicros: bigint; pendingTimeoutMs: number; pendingPollMs: number;
};
export type PackDemoSummary = {
  bought: boolean; txHash: string | null; passed: number; notMet: number; upstreamErrors: number;
  down: number; lastRemaining: number | null; creditAccountingOk: boolean;
};

export type RecoverResult =
  | { kind: "recovered"; token: string; credits: number; pending: boolean }
  /** 404: the gateway never received the payment, so nothing was paid. */
  | { kind: "not_received" }
  /** 403: final, the gateway will never accept this saved payment. */
  | { kind: "refused" }
  /** Anything else: keep the saved payment and try again later. */
  | { kind: "failed"; status: number };

/**
 * Presents a signed pack payment whose settlement failed or timed out to the gateway's /recover, with the
 * recovery secret whose sha256 travelled as X-Hirakumi-Recovery, and gets the pack's token re-keyed.
 */
export async function recoverPack(
  fetchImpl: FetchLike,
  gatewayUrl: string,
  apiId: string,
  saved: Pick<PendingPayment, "packId" | "paymentSignature" | "recoverySecret">,
): Promise<RecoverResult> {
  const url = `${gatewayUrl.replace(/\/+$/, "")}/a/${encodeURIComponent(apiId)}/packs/${encodeURIComponent(saved.packId)}/recover`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "payment-signature": saved.paymentSignature, "x-hirakumi-recovery-secret": saved.recoverySecret, accept: "application/json" },
  });
  const body = (await res.json().catch(() => ({}))) as { token?: unknown; credits?: unknown; status?: unknown };
  if (res.status === 404) return { kind: "not_received" };
  if (res.status === 403) return { kind: "refused" };
  if (!res.ok || typeof body.token !== "string" || typeof body.credits !== "number") return { kind: "failed", status: res.status };
  return { kind: "recovered", token: body.token, credits: body.credits, pending: body.status === "pending" };
}

function describe(o: CallOutcome): string {
  return o.kind === "unexpected" ? `HTTP ${o.status}` : o.kind;
}

export async function runPackDemo(deps: PackDemoDeps, o: PackDemoOptions): Promise<PackDemoSummary> {
  const s: PackDemoSummary = { bought: false, txHash: null, passed: 0, notMet: 0, upstreamErrors: 0, down: 0, lastRemaining: null, creditAccountingOk: true };
  const target = { gatewayUrl: o.gatewayUrl, apiId: o.apiId, opId: o.opId, query: o.query };

  /** A payment from an earlier run whose settlement timed out: re-key its token instead of paying again. */
  const recover = async (): Promise<string | null> => {
    const saved = deps.pending.get(o.apiId);
    if (!saved) return null;
    deps.log(`Recovering the pack payment from ${saved.at} (its settlement timed out)...`);
    const r = await recoverPack(deps.fetch, o.gatewayUrl, o.apiId, saved);
    if (r.kind === "not_received") {
      deps.log("The gateway never received that payment, so nothing was paid. Buying a new pack.");
      deps.pending.delete(o.apiId);
      return null;
    }
    if (r.kind === "refused") {
      // Final: the gateway will never accept this saved payment (e.g. saved before recovery secrets existed).
      deps.pending.delete(o.apiId);
      throw new Error(
        `The pack payment from ${saved.at} can't be recovered (the gateway refused it). It was cleared; run again to buy a new pack.`,
      );
    }
    if (r.kind === "failed") {
      throw new Error(`Recovery failed: HTTP ${r.status}. Your saved payment is kept; try again later.`);
    }
    deps.log(`Recovered: ${r.credits} credits${r.pending ? " (still confirming on-chain)" : ""}.`);
    deps.tokens.put(o.apiId, { token: r.token, packId: saved.packId, credits: r.credits, txHash: null, boughtAt: saved.at });
    deps.pending.delete(o.apiId);
    s.lastRemaining = r.credits;
    return r.token;
  };

  const buy = async (offer: CreditsRequired): Promise<string> => {
    const recovered = await recover();
    if (recovered) return recovered;
    const pack = choosePack(offer, o.maxPackMicros);
    deps.log(`402 credits_required. Promise ${offer.ruleHash} (${offer.ruleUrl})`);
    deps.log(`Buying pack ${pack.packId}: ${pack.calls} calls for ${formatMicros(pack.price)} tUSDM, one Cardano preprod payment (about 20-60s)...`);
    const started = deps.now();
    let p: PackPurchase;
    try {
      p = await deps.buyPack(pack.buyUrl, { amount: BigInt(pack.price) });
    } catch (e) {
      if (e instanceof PackPurchaseError && e.settlementFailed && e.paymentSignature && e.recoverySecret) {
        deps.pending.put(o.apiId, { packId: pack.packId, paymentSignature: e.paymentSignature, recoverySecret: e.recoverySecret, at: new Date(deps.now()).toISOString() });
        deps.log("The payment didn't confirm in time, but it may still land on-chain. It is saved: Run the same command again in a minute to recover your credits. You won't pay twice.");
      }
      throw e;
    }
    deps.log(
      `Paid in ${((deps.now() - started) / 1000).toFixed(1)}s: ${p.credits} credits.` +
        (p.txHash ? ` Tx https://preprod.cardanoscan.io/transaction/${p.txHash}` : " (no receipt header)"),
    );
    deps.tokens.put(o.apiId, { token: p.token, packId: pack.packId, credits: p.credits, txHash: p.txHash, boughtAt: new Date(deps.now()).toISOString() });
    s.bought = true;
    s.txHash = p.txHash;
    s.lastRemaining = p.credits;
    return p.token;
  };

  const checkCredits = (remaining: number | null, charged: boolean) => {
    if (remaining === null) {
      if (!charged) deps.log("   (no X-Credits-Remaining on this refusal; the next 200 confirms nothing was charged)");
      return;
    }
    if (s.lastRemaining !== null) {
      const expected = charged ? s.lastRemaining - 1 : s.lastRemaining;
      if (remaining !== expected) {
        s.creditAccountingOk = false;
        deps.log(`   CREDIT MISMATCH: expected ${expected}, gateway says ${remaining}`);
      } else if (!charged) {
        deps.log(`   credits unchanged: ${remaining}`);
      }
    }
    s.lastRemaining = remaining;
  };

  let token = deps.tokens.get(o.apiId)?.token;
  if (token) {
    deps.log(`Using the stored credit token for ${o.apiId}`);
  } else {
    const first = await callOperation(deps.fetch, target);
    if (first.kind === "down") {
      s.down++;
      deps.log(`503 Down: ${first.message}. No payment made.`);
      return s;
    }
    if (first.kind !== "credits_required") throw new Error(`Expected 402 credits_required, got ${describe(first)}`);
    token = await buy(first.offer);
  }

  let pendingSince: number | null = null;
  let i = 1;
  while (i <= o.calls) {
    const r = await callOperation(deps.fetch, { ...target, token });
    if (r.kind === "token_pending") {
      pendingSince ??= deps.now();
      if (deps.now() - pendingSince >= o.pendingTimeoutMs) {
        throw new Error(`Credit token still pending after ${o.pendingTimeoutMs}ms: the payment has not settled`);
      }
      deps.log("Token pending: waiting for settlement...");
      await deps.sleep(o.pendingPollMs);
      continue;
    }
    pendingSince = null;
    let stop = false;
    switch (r.kind) {
      case "ok":
        s.passed++;
        deps.log(`#${i} 200 in ${r.latencyMs}ms  credits left: ${r.remaining ?? "?"}  ${JSON.stringify(r.body)}`);
        checkCredits(r.remaining, true);
        break;
      case "promise_not_met":
        s.notMet++;
        deps.log(`#${i} 422 promise not met: ${r.reasons.join("; ")}`);
        checkCredits(r.remaining, false);
        break;
      case "upstream_error":
        s.upstreamErrors++;
        deps.log(`#${i} ${r.status} upstream error: ${r.reasons.join("; ")}`);
        checkCredits(r.remaining, false);
        break;
      case "down":
        s.down++;
        deps.log(`#${i} 503 Down: ${r.message}. No credit used.`);
        break;
      case "credits_required":
        deps.log(`#${i} 402: credits used up. Stopping.`);
        stop = true;
        break;
      case "bad_input":
        throw new Error(`400 bad input: ${r.message}`);
      case "invalid_token":
        deps.tokens.delete(o.apiId);
        throw new Error(`The gateway rejected the stored token (${r.message}). Deleted it; run again to buy a new pack.`);
      case "unexpected":
        throw new Error(`Unexpected HTTP ${r.status}: ${r.text}`);
    }
    if (stop) break;
    i++;
    if (i <= o.calls) await deps.sleep(o.intervalMs);
  }

  deps.log(
    `Summary: ${s.passed} passed, ${s.notMet} promise not met, ${s.upstreamErrors} upstream errors, ${s.down} down. ` +
      `Credits left: ${s.lastRemaining ?? "?"}. Credit accounting ${s.creditAccountingOk ? "OK: refusals used no credits" : "MISMATCH"}.`,
  );
  return s;
}
