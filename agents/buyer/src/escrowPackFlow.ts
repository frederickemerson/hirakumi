// The escrow pack demo: buy (after checking the datum), call, verify each pass locally, sign IOUs, close.
import type { RuleDefinition } from "@hirakumi/core";
import { choosePack, formatMicros, parseCreditsRequired, safeJson, type FetchLike } from "./gatewayClient.js";
import type { EscrowPurchase, OfferCheck } from "./payClient.js";
import { checkEscrowOffer, escrowCall, requestEscrowClose, type EscrowChannel, type IouKeyStore } from "./escrowPack.js";

export type EscrowFlowDeps = {
  fetch: FetchLike;
  buyEscrowPack: (buyUrl: string, keys: { receiptKey: string; refundAddress: string }, check: OfferCheck) => Promise<EscrowPurchase>;
  store: IouKeyStore;
  refundAddress: string;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
};
export type EscrowFlowOptions = {
  gatewayUrl: string; apiId: string; opId: string; query: Record<string, string>; calls: number; intervalMs: number;
  maxPackMicros: bigint; pendingTimeoutMs: number; pendingPollMs: number;
};
export type EscrowFlowSummary = { channelId: string | null; passed: number; signed: number; notMet: number; disputed: boolean; stoppedFor: string | null };

export function ruleFetcher(fetchImpl: FetchLike, gatewayUrl: string): (hash: string) => Promise<RuleDefinition> {
  const cache = new Map<string, RuleDefinition>();
  return async (hash) => {
    const hit = cache.get(hash);
    if (hit) return hit;
    const res = await fetchImpl(new URL(`/r/${encodeURIComponent(hash)}`, gatewayUrl).toString(), { headers: { accept: "application/json" } });
    const body = safeJson(await res.text()) as { definition?: RuleDefinition; ruleHash?: string } | undefined;
    if (!res.ok || !body?.definition || body.ruleHash !== hash) throw new Error(`could not fetch the promise ${hash} (HTTP ${res.status})`);
    cache.set(hash, body.definition);
    return body.definition;
  };
}

/** The stored channel for this API that already has a token, if any. */
function storedFor(store: IouKeyStore, apiId: string, packIds: string[]): EscrowChannel | undefined {
  for (const id of packIds) {
    const c = store.get(apiId, id);
    if (c?.token && !c.disputed) return c;
  }
  return undefined;
}

export async function runEscrowPack(deps: EscrowFlowDeps, o: EscrowFlowOptions): Promise<EscrowFlowSummary> {
  const s: EscrowFlowSummary = { channelId: null, passed: 0, signed: 0, notMet: 0, disputed: false, stoppedFor: null };
  const callUrl = new URL(`/a/${encodeURIComponent(o.apiId)}/x/${encodeURIComponent(o.opId)}`, o.gatewayUrl);
  for (const [k, v] of Object.entries(o.query)) callUrl.searchParams.set(k, v);
  const rule = ruleFetcher(deps.fetch, o.gatewayUrl);
  const save = (c: EscrowChannel) => deps.store.put(c);

  // Find the offer (the unauthenticated call answers 402 credits_required with the packs).
  const first = await deps.fetch(callUrl.toString(), { headers: { accept: "application/json" } });
  const firstBody = safeJson(await first.text());
  if (first.status !== 402) throw new Error(`expected 402 credits_required, got HTTP ${first.status}`);
  const offer = parseCreditsRequired(firstBody, o.gatewayUrl);
  let c = storedFor(deps.store, o.apiId, offer.packs.map((p) => p.packId));
  if (c) {
    deps.log(`Using the stored escrow channel ${c.channelId} (signed up to ${c.lastSigned}, verified ${c.verifiedPasses}).`);
  } else {
    const pack = choosePack(offer, o.maxPackMicros);
    const ch = deps.store.ensure(o.apiId, pack.packId, deps.refundAddress, deps.now());
    deps.log(`Buying escrow pack ${pack.packId}: ${pack.calls} calls for ${formatMicros(pack.price)} tUSDM, locked at the pack_escrow script.`);
    deps.log(`IOU key ${ch.publicKey.slice(0, 16)}…, refunds to ${deps.refundAddress}`);
    const check: OfferCheck = (req) => {
      const d = checkEscrowOffer(req, { receiptKey: ch.publicKey, refundAddress: deps.refundAddress, maxPackMicros: o.maxPackMicros });
      deps.log(`Datum checked: ${d.maxCalls} × ${formatMicros(d.pricePerCall)} tUSDM, fee ${d.feeBps} bps, contest ${Number(d.contestPeriod) / 1000}s, channel ${d.channelId}`);
    };
    const p = await deps.buyEscrowPack(pack.buyUrl, { receiptKey: ch.publicKey, refundAddress: deps.refundAddress }, check);
    ch.channelId = p.channelId;
    ch.token = p.token;
    ch.ruleHash = offer.ruleHash;
    save(ch);
    deps.log(`Locked: ${p.txHash ? `https://preprod.cardanoscan.io/transaction/${p.txHash}` : "(no tx header)"}  channel ${p.channelUrl ?? p.channelId}`);
    c = ch;
  }
  s.channelId = c.channelId;

  let pendingSince: number | null = null;
  for (let i = 1; i <= o.calls; ) {
    const r = await escrowCall({ fetch: deps.fetch, rule, save }, c, callUrl.toString());
    if (r.kind === "pending") {
      pendingSince ??= deps.now().getTime();
      if (deps.now().getTime() - pendingSince > o.pendingTimeoutMs) { s.stoppedFor = "lock_not_verified"; break; }
      deps.log("Lock not verified on-chain yet: waiting...");
      await deps.sleep(o.pendingPollMs);
      continue;
    }
    pendingSince = null;
    if (r.kind === "pass") {
      s.passed++;
      if (r.signed !== null) s.signed = r.signed;
      deps.log(`#${i} 200, checked locally: pass. Signed IOU ${r.signed ?? "-"}  ${JSON.stringify(r.body)}`);
    } else if (r.kind === "dispute") {
      s.disputed = true;
      s.stoppedFor = "dispute";
      deps.log(`#${i} PROMISE DISPUTE: the gateway served this as a pass but our check fails (${r.reasons.join("; ")}). Not signing; closing.`);
      const closed = await requestEscrowClose(deps.fetch, o.gatewayUrl, c);
      deps.log(`Close requested: HTTP ${closed.status}`);
      break;
    } else if (r.kind === "not_met" || r.kind === "upstream_error") {
      s.notMet++;
      deps.log(`#${i} ${r.status}: not a pass, nothing to sign`);
    } else if (r.kind === "down") {
      deps.log(`#${i} 503 Down: nothing charged`);
    } else {
      s.stoppedFor = r.kind;
      deps.log(`#${i} stopping: ${r.kind} ${JSON.stringify("body" in r ? r.body : r)}`);
      break;
    }
    i++;
    if (i <= o.calls) await deps.sleep(o.intervalMs);
  }
  deps.log(`Summary: ${s.passed} passes verified locally, IOU signed up to ${c.lastSigned}, ${s.notMet} refusals.${s.disputed ? " DISPUTE raised." : ""}`);
  return s;
}

/** `--close`: asks the gateway to close with our latest IOU, then (optionally) waits for Settle. */
export async function closeEscrowPack(
  deps: Pick<EscrowFlowDeps, "fetch" | "store" | "log" | "sleep">,
  o: { gatewayUrl: string; apiId: string; packIds?: string[]; wait: boolean; pollMs: number; timeoutMs: number },
): Promise<unknown> {
  const all = (o.packIds?.length ? o.packIds.map((id) => deps.store.get(o.apiId, id)) : deps.store.list(o.apiId)).filter((c): c is EscrowChannel => !!c?.channelId);
  const c = all[0];
  if (!c) throw new Error(`no escrow channel stored for ${o.apiId}`);
  const r = await requestEscrowClose(deps.fetch, o.gatewayUrl, c);
  deps.log(`Close requested for ${c.channelId} with IOU ${c.lastSigned}: HTTP ${r.status} ${JSON.stringify((r.body as { status?: unknown })?.status ?? r.body)}`);
  if (!o.wait) return r.body;
  const url = new URL(`/a/${encodeURIComponent(c.apiId)}/channels/${c.channelId}`, o.gatewayUrl).toString();
  const started = Date.now();
  for (;;) {
    const v = safeJson(await (await deps.fetch(url, { headers: { accept: "application/json" } })).text()) as { status?: string; payouts?: unknown; txs?: unknown } | undefined;
    deps.log(`channel ${v?.status}`);
    if (v?.status === "settled") {
      deps.log(`Settled: ${JSON.stringify(v.payouts)}  ${JSON.stringify(v.txs)}`);
      return v;
    }
    if (Date.now() - started > o.timeoutMs) throw new Error("timed out waiting for Settle");
    await deps.sleep(o.pollMs);
  }
}
