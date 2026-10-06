// Real preprod run of the pack escrow: x402 `script` lock through the hosted
// facilitator → IOUs → Close → Raise → (contest period) → Settle; and a second
// pack where the buyer closes with 0 and Settle refunds everything.
//
//   ENV_FILE=<repo .env> ESCROW_RUN_SECRETS=<0600 file> ESCROW_RUN_STATE=<json> pnpm --filter @hirakumi/escrow-run run <phase>
//   phases: setup lock1 close1 raise1 settle1 lock2 close2 settle2 report all1 all2
//
// Secrets (mnemonics, IOU keys) live only in the two files outside git. Nothing here prints them.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Assets, Client, Redeemer, Transaction, TransactionHash, TransactionInput, preprod, Address } from "@evolution-sdk/evolution";
import { Effect } from "effect";
import { toClientCardanoSigner, USDM_PREPROD_ASSET } from "@x402/cardano";
import { ExactCardanoScheme } from "@x402/cardano/exact/client";
import { HTTPFacilitatorClient } from "@x402/core/server";
import {
  PACK_ESCROW,
  addressUtxos,
  checkLockOutput,
  closePayouts,
  deriveChannelId,
  encodePackDatum,
  newReceiptKey,
  signReceipt,
  tip,
  txOutputs,
  txSummary,
  validateDatumForLock,
  type Blockfrost,
  type PackDatum,
} from "@hirakumi/escrow";
import { buildClose, buildRaise, buildSettle, lockState, settleFromMs, slotOfMs, type ScriptSource, type Wallet } from "@hirakumi/escrow/txs";
import { loadEnv, need, seedConfig, walletFor } from "./lib.js";

loadEnv();
const FACILITATOR = process.env.FACILITATOR_URL_ESCROW ?? "https://x402.preprod.dev.ecosyseng.cf-deployments.org";
const BF: Blockfrost = { baseUrl: need("BLOCKFROST_BASE_URL"), projectId: need("BLOCKFROST_PROJECT_ID") };
const [POLICY, NAME] = USDM_PREPROD_ASSET.split(".") as [string, string];
const UNIT = POLICY + NAME;
const PRICE_PER_CALL = 20_000n;
const CALLS = 100n;
const CONTEST_MS = 180_000n;
const FEE_BUDGET = 700_000n;
const SCRIPT: ScriptSource = { kind: "inline" };

const STATE = need("ESCROW_RUN_STATE");
type Run = {
  receiptSecret: string;
  receiptKey: string;
  channelId: string;
  datumCbor: string;
  ious: Record<string, string>;
  at?: { txHash: string; index: number };
  txs: Record<string, string>;
  contestEnd?: string;
  lockMinUtxo?: string;
};
type State = { fundTx?: string; runs: Record<string, Run> };
const load = (): State => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { runs: {} });
const save = (s: State) => writeFileSync(STATE, JSON.stringify(s, null, 2), { mode: 0o600 });

const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m.replaceAll(BF.projectId, "<bf>")}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const mk = (mnemonic: string, account = 0): Wallet =>
  Client.make(preprod).withBlockfrost({ baseUrl: BF.baseUrl, projectId: BF.projectId }).withSeed(seedConfig(mnemonic, account));
const buyer = mk(need("BUYER_MNEMONIC"));
const operator = mk(need("OPERATOR_MNEMONIC"));
const buyerW = walletFor(need("BUYER_MNEMONIC"));
const operatorW = walletFor(need("OPERATOR_MNEMONIC"));
const feeW = walletFor(need("FEE_MNEMONIC"));
const SELLER = need("SELLER_ADDRESS");
if (buyerW.address !== need("BUYER_ADDRESS")) throw new Error("BUYER_MNEMONIC does not derive BUYER_ADDRESS");

async function confirmed(hash: string, w?: Wallet): Promise<void> {
  for (let i = 0; i < 90; i++) {
    if (await txSummary(BF, hash)) break;
    await sleep(5000);
    if (i === 89) throw new Error(`${hash} not confirmed`);
  }
  if (!w) return;
  // Blockfrost's address index can lag the tx index: wait until the wallet no longer lists spent inputs.
  const u = (await (await fetch(`${BF.baseUrl}/txs/${hash}/utxos`, { headers: { project_id: BF.projectId } })).json()) as {
    inputs: { tx_hash: string; output_index: number; collateral: boolean; reference: boolean }[];
  };
  const spent = new Set(u.inputs.filter((i) => !i.collateral && !i.reference).map((i) => `${i.tx_hash}#${i.output_index}`));
  for (let i = 0; i < 30; i++) {
    const listed = (await w.getWalletUtxos()).map((x) => `${TransactionHash.toHex(x.transactionId)}#${x.index}`);
    if (!listed.some((k) => spent.has(k))) return;
    await sleep(3000);
  }
}

async function submit(what: string, sb: { sign(): Promise<{ submit(): Promise<TransactionHash.TransactionHash> }> }, w: Wallet, fee: bigint): Promise<string> {
  const h = TransactionHash.toHex(await (await sb.sign()).submit());
  log(`${what}: submitted ${h} (fee ${fee})`);
  await confirmed(h, w);
  log(`${what}: confirmed`);
  return h;
}

async function packUtxo(r: Run) {
  const ref = new TransactionInput.TransactionInput({ transactionId: TransactionHash.fromHex(r.at!.txHash), index: BigInt(r.at!.index) });
  for (let i = 0; i < 20; i++) {
    const [u] = await operator.getUtxosByOutRef([ref]).catch(() => []);
    if (u) return lockState(u);
    await sleep(3000);
  }
  throw new Error(`${r.at!.txHash}#${r.at!.index} not found`);
}

async function waitChainTime(ms: bigint) {
  const slot = Number(slotOfMs(ms));
  for (;;) {
    const t = await tip(BF);
    if (t.slot >= slot) return;
    log(`waiting for slot ${slot}: tip ${t.slot} (${slot - t.slot} s)`);
    await sleep(Math.min(30_000, (slot - t.slot) * 1000 + 3000));
  }
}

// ---- phases ----

async function setup() {
  const s = load();
  log(`buyer ${buyerW.address}\noperator ${operatorW.address} (closer vkh ${operatorW.vkh})\nfee ${feeW.address}\nseller ${SELLER}`);
  if (!s.fundTx) {
    // Two outputs: one pays fees / payout min-ADA, one stays pure ADA for collateral.
    const sb = await buyer
      .newTx()
      .payToAddress({ address: Address.fromBech32(operatorW.address), assets: Assets.fromLovelace(4_000_000n) })
      .payToAddress({ address: Address.fromBech32(operatorW.address), assets: Assets.fromLovelace(2_500_000n) })
      .build({ changeAddress: await buyer.address(), setCollateral: 2_000_000n });
    s.fundTx = await submit("fund operator 6.5 tADA", sb, buyer, (await sb.toTransaction()).body.fee);
    save(s);
  }
}

function newDatum(r: Pick<Run, "receiptKey" | "channelId">): PackDatum {
  return {
    channelId: r.channelId,
    receiptKey: r.receiptKey,
    buyerRefund: buyerW.address,
    seller: SELLER,
    policyId: POLICY,
    assetName: NAME,
    pricePerCall: PRICE_PER_CALL,
    maxCalls: CALLS,
    ruleHash: createHash("sha256").update("hirakumi escrow-run demo promise").digest("hex"),
    feeAddress: feeW.address,
    feeBps: 300n,
    closer: operatorW.vkh,
    contestPeriod: CONTEST_MS,
    closeFeeBudget: FEE_BUDGET,
    stage: { kind: "open" },
  };
}

async function lock(name: string) {
  const s = load();
  if (s.runs[name]?.txs.lock) return log(`${name}: already locked ${s.runs[name]!.txs.lock}`);
  const prior = s.runs[name];
  if (prior) {
    // A settle that timed out may still have landed: look for our datum at the script.
    for (let i = 0; i < 24; i++) {
      const found = (await addressUtxos(BF, PACK_ESCROW.address)).filter((o) => o.datumCbor === prior.datumCbor);
      if (found.length) {
        const check = checkLockOutput(found, { datumCbor: prior.datumCbor, unit: UNIT, priceMicros: PRICE_PER_CALL * CALLS });
        if (!check.ok) throw new Error(`lock check failed: ${check.reason}`);
        prior.at = { txHash: check.output.txHash, index: check.output.index };
        prior.txs.lock = check.output.txHash;
        prior.lockMinUtxo = check.output.lovelace.toString();
        save(s);
        await confirmed(check.output.txHash, buyer);
        return log(`${name}: earlier lock landed ${check.output.txHash}#${check.output.index}, ${check.output.lovelace} lovelace`);
      }
      log(`${name}: waiting for an earlier lock to show up (${i})`);
      await sleep(10_000);
    }
    throw new Error(`${name}: earlier lock attempt never landed; delete runs.${name} from state to retry`);
  }
  const k = newReceiptKey();
  const channelId = deriveChannelId({ apiId: "escrow-run", packId: name, receiptKey: k.publicKey, refundAddress: buyerW.address, quoteNonce: randomBytes(16).toString("hex") });
  const datum = newDatum({ receiptKey: k.publicKey, channelId });
  const price = PRICE_PER_CALL * CALLS;
  validateDatumForLock(datum, { priceMicros: price });
  const datumCbor = encodePackDatum(datum);
  const r: Run = { receiptSecret: k.secretKey, receiptKey: k.publicKey, channelId, datumCbor, ious: {}, txs: {} };
  s.runs[name] = r;
  save(s);

  const requirements = {
    scheme: "exact",
    network: "cardano:preprod",
    asset: USDM_PREPROD_ASSET,
    amount: price.toString(),
    payTo: PACK_ESCROW.address,
    maxTimeoutSeconds: 600,
    extra: { assetTransferMethod: "script", script: { type: "plutusV3", code: PACK_ESCROW.scriptCbor }, datum: datumCbor },
  } as const;
  const signer = toClientCardanoSigner({ network: "cardano:preprod", mnemonic: need("BUYER_MNEMONIC"), provider: { blockfrost: { baseUrl: BF.baseUrl, projectId: BF.projectId } } });
  const created = await new ExactCardanoScheme(signer).createPaymentPayload(2, requirements as never);
  const payload = { x402Version: 2, accepted: requirements, payload: created.payload, resource: { url: "https://hirakumi.invalid/escrow-run", description: "escrow run", mimeType: "application/json" } };
  const fac = new HTTPFacilitatorClient({ url: FACILITATOR });
  const v = await fac.verify(payload as never, requirements as never);
  log(`${name} /verify: ${JSON.stringify(v)}`);
  if (!v.isValid) throw new Error("facilitator refused verify");
  const st = await fac.settle(payload as never, requirements as never);
  log(`${name} /settle: ${JSON.stringify(st)}`);
  if (!st.success || !st.transaction) throw new Error("settle failed");
  await confirmed(st.transaction, buyer);
  const outs = (await txOutputs(BF, st.transaction))!;
  const check = checkLockOutput(outs, { datumCbor, unit: UNIT, priceMicros: price });
  if (!check.ok) throw new Error(`lock check failed: ${check.reason}`);
  r.at = { txHash: st.transaction, index: check.output.index };
  r.txs.lock = st.transaction;
  r.lockMinUtxo = check.output.lovelace.toString();
  save(s);
  log(`${name}: locked ${price} micros + ${check.output.lovelace} lovelace at ${PACK_ESCROW.address}#${check.output.index}; datum byte-exact`);
}

function iou(r: Run, n: bigint): string {
  r.ious[n.toString()] ??= signReceipt(r.receiptSecret, r.channelId, n);
  return r.ious[n.toString()]!;
}

async function close1() {
  const s = load();
  const r = s.runs.run1!;
  if (r.txs.close) return;
  for (const n of [1n, 2n, 3n]) iou(r, n); // buyer signs IOUs 1…3 as passes arrive
  save(s);
  const lock = await packUtxo(r);
  const validTo = BigInt(Date.now()) + 150_000n;
  const b = await buildClose(operator, { lock, accepted: 1n, signature: iou(r, 1n), signerVkh: operatorW.vkh, validToMs: validTo, script: SCRIPT });
  r.txs.close = await submit("run1 Close{1} by closer", b.signBuilder, operator, b.fee);
  r.at = { txHash: r.txs.close, index: 0 };
  r.contestEnd = (b.next!.stage as { contestEnd: bigint }).contestEnd.toString();
  const outs = (await txOutputs(BF, r.txs.close))!;
  r.at.index = outs.find((o) => o.address === PACK_ESCROW.address)!.index;
  save(s);
  log(`run1 contest_end ${new Date(Number(r.contestEnd)).toISOString()}`);
}

async function raise1() {
  const s = load();
  const r = s.runs.run1!;
  if (r.txs.raise) return;
  const lock = await packUtxo(r);
  const b = await buildRaise(operator, { lock, accepted: 3n, signature: iou(r, 3n), validToMs: BigInt(Date.now()) + 120_000n, script: SCRIPT });
  r.txs.raise = await submit("run1 Raise{3}", b.signBuilder, operator, b.fee);
  const outs = (await txOutputs(BF, r.txs.raise))!;
  r.at = { txHash: r.txs.raise, index: outs.find((o) => o.address === PACK_ESCROW.address)!.index };
  save(s);
}

async function settle(name: string) {
  const s = load();
  const r = s.runs[name]!;
  if (r.txs.settle) return;
  const lock = await packUtxo(r);
  if (lock.datum.stage.kind !== "closing") throw new Error("not closing");
  const from = settleFromMs(lock.datum.stage.contestEnd);
  await waitChainTime(from);
  const b = await buildSettle(operator, { lock, script: SCRIPT, fromMs: from });
  log(`${name} Settle payouts: ${b.payouts.map((p) => `${p.address.slice(0, 20)}… ${p.tokens} micros + ${p.lovelace} lovelace`).join("; ")}`);
  await evaluateFinal(b.signBuilder);
  log(`${name} Settle ex-units (fixed, +5%): mem ${b.exUnits.mem} steps ${b.exUnits.steps}; fee ${b.fee} ≤ budget ${FEE_BUDGET}`);
  r.txs.settle = await submit(`${name} Settle`, b.signBuilder, operator, b.fee);
  save(s);
}

async function close2() {
  const s = load();
  const r = s.runs.run2!;
  if (r.txs.close) return;
  const lock = await packUtxo(r);
  // The buyer authorises (its payment key is the required signer); the operator wallet pays the
  // network fee and collateral, so a buyer holding only tokens can still exit.
  const b = await buildClose(operator, { lock, accepted: 0n, signerVkh: buyerW.vkh, validToMs: BigInt(Date.now()) + 150_000n, script: SCRIPT });
  const tx = await b.signBuilder.toTransaction();
  const opWit = await b.signBuilder.partialSign();
  const buyerWit = await buyer.signTx(tx);
  const submitter = await b.signBuilder.assemble([opWit, buyerWit]);
  const h = TransactionHash.toHex(await submitter.submit());
  log(`run2 Close{0} signed by the buyer, no IOU: submitted ${h} (fee ${b.fee})`);
  await confirmed(h, operator);
  r.txs.close = h;
  const outs = (await txOutputs(BF, r.txs.close))!;
  r.at = { txHash: r.txs.close, index: outs.find((o) => o.address === PACK_ESCROW.address)!.index };
  r.contestEnd = (b.next!.stage as { contestEnd: bigint }).contestEnd.toString();
  save(s);
}

async function report() {
  const s = load();
  if (s.fundTx) log(`fund ${s.fundTx}`);
  for (const [name, r] of Object.entries(s.runs)) {
    log(`== ${name} channel ${r.channelId} lock lovelace (min-UTxO) ${r.lockMinUtxo}`);
    for (const [step, h] of Object.entries(r.txs)) {
      const t = await txSummary(BF, h);
      const ex = t?.redeemers.map((x) => `${x.purpose} mem ${x.mem} steps ${x.steps}`).join("; ") ?? "";
      log(`${step.padEnd(7)} ${h} fee ${t?.fees} size ${t?.size} ${ex}`);
      if (step === "settle") {
        const outs = (await txOutputs(BF, h))!;
        for (const o of outs) {
          const who = o.address === SELLER ? "seller" : o.address === feeW.address ? "fee" : o.address === buyerW.address ? "buyer" : o.address === operatorW.address ? "operator(change)" : o.address;
          log(`   → ${who}: ${o.assets[UNIT] ?? 0n} micros tUSDM, ${o.lovelace} lovelace, datum ${o.datumCbor}`);
        }
        const p = closePayouts({ pricePerCall: PRICE_PER_CALL, feeBps: 300n }, PRICE_PER_CALL * CALLS, name === "run1" ? 3n : 0n);
        log(`   expected seller ${p.seller}, fee ${p.fee}, buyer ${p.buyer}; budget ${FEE_BUDGET}`);
      }
    }
  }
}

/** Phase-2 check of the exact tx we will submit (its fee field is final). */
async function evaluateFinal(sb: { toTransaction(): Promise<Transaction.Transaction> }) {
  const cbor = Buffer.from(Transaction.toCBORBytes(await sb.toTransaction())).toString("hex");
  const res = await fetch(`${BF.baseUrl}/utils/txs/evaluate?version=6`, { method: "POST", headers: { project_id: BF.projectId, "content-type": "application/cbor" }, body: cbor });
  const body = (await res.json()) as { result?: { budget: { memory: number; cpu: number } }[]; error?: unknown };
  if (!body.result) throw new Error(`final evaluation failed: ${JSON.stringify(body.error).slice(0, 1500)}`);
  log(`final evaluation ok: ${body.result.map((r) => `mem ${r.budget.memory} cpu ${r.budget.cpu}`).join("; ")}`);
}

/** Builds Settle with fixed ex-units and shows Blockfrost's raw evaluation, for when evaluation fails opaquely. */
async function debugSettle(name: string) {
  const s = load();
  const r = s.runs[name]!;
  const lock = await packUtxo(r);
  if (lock.datum.stage.kind !== "closing") throw new Error("not closing");
  let captured = "";
  const evaluator = {
    evaluate: (tx: any) => {
      if (!captured || !process.env.FIRST) captured = Buffer.from(Transaction.toCBORBytes(tx)).toString("hex");
      const idx = (tx.body.inputs as any[]).findIndex((i) => TransactionHash.toHex(i.transactionId) === r.at!.txHash && Number(i.index) === r.at!.index);
      return Effect.succeed([{ ex_units: new Redeemer.ExUnits({ mem: 3_000_000n, steps: 1_500_000_000n }), redeemer_index: idx, redeemer_tag: "spend" as const }]);
    },
  };
  const b = await buildSettle(operator, { lock, script: SCRIPT, fromMs: settleFromMs(lock.datum.stage.contestEnd), build: { evaluator } as never });
  log(`built with fee ${b.fee}; payouts ${JSON.stringify(b.payouts, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  const res = await fetch(`${BF.baseUrl}/utils/txs/evaluate?version=6`, { method: "POST", headers: { project_id: BF.projectId, "content-type": "application/cbor" }, body: captured });
  log(`evaluate: ${res.status} ${(await res.text()).slice(0, 3000)}`);
}

/** Moves the fee wallet's ADA (and the fee tokens) to the operator, which funds payout min-ADA. */
async function sweepFee() {
  const fee = mk(need("FEE_MNEMONIC"));
  const sb = await fee.newTx().sendAll({ to: Address.fromBech32(operatorW.address) }).build();
  await submit("sweep fee wallet → operator", sb, fee, (await sb.toTransaction()).body.fee);
}

const phases: Record<string, () => Promise<void>> = {
  sweepFee,
  debug1: () => debugSettle("run1"),
  setup,
  lock1: () => lock("run1"),
  close1,
  raise1,
  settle1: () => settle("run1"),
  lock2: () => lock("run2"),
  close2,
  settle2: () => settle("run2"),
  report,
  all1: async () => {
    await setup();
    await lock("run1");
    await close1();
    await raise1();
    await settle("run1");
  },
  all2: async () => {
    await lock("run2");
    await close2();
    await settle("run2");
  },
};
const phase = process.argv[2] ?? "";
if (!phases[phase]) throw new Error(`phase: one of ${Object.keys(phases).join(", ")}`);
phases[phase]!().catch((e: unknown) => {
  let msg = "";
  for (let c: any = e, d = 0; c && d < 8; c = c.cause, d++) msg += `\n  ${String(c.message ?? JSON.stringify(c)).slice(0, 1500)}`;
  console.error(msg.replaceAll(BF.projectId, "<bf>"));
  process.exit(1);
});
