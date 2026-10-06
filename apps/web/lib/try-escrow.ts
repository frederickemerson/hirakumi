import { compileRule, type RuleDefinition } from "@hirakumi/core";
import { signReceipt } from "@hirakumi/escrow/iou";

/*
 * "Try it live" with an escrow pack: Hirakumi's demo wallet is the buyer, so it does what the buyer agent does
 * (agents/buyer/src/escrowPack.ts). It sends its latest IOU with each call, re-checks every answer the gateway
 * served as a pass against the published promise, and signs an IOU only up to the passes it checked itself.
 * The contract pays the seller only what the latest IOU accepts; the rest of the lock refunds to the wallet.
 */

/** The escrow side of a live pack. The IOU key never leaves the server. */
export type TryChannel = {
  tryId: string;
  channelId: string;
  secretKey: string;
  /** The promise the lock was made for ("sha256:…"): answers are checked against this one only. */
  ruleHash: string;
  lastIou: string | null;
};

/** The demo wallet's IOU state, in the database so every serverless instance shares it. */
export type TryEscrowStore = {
  /** The promise's definition, or null when no rule with this hash exists (its content must hash to it). */
  rule(ruleHash: string): Promise<RuleDefinition | null>;
  /** Counts one checked pass; returns the passes checked so far. Atomic. */
  countPass(tryId: string): Promise<number>;
  /** Passes checked so far. */
  verified(tryId: string): Promise<number>;
  /** Keeps IOU n if it is newer than the one kept (two calls at once can finish in either order). */
  saveIou(tryId: string, n: number, iou: string): Promise<void>;
  /** The gateway served an answer that breaks the promise as a pass: never sign for this channel again. */
  dispute(tryId: string): Promise<void>;
};

export type EscrowOutcome = {
  res: Response;
  text: string;
  /** The IOU count signed after this call, or null when none was. */
  iouSigned: number | null;
  disputed: boolean;
};

export const IOU_HEADER = "x-hirakumi-iou";
export const SIGN_NEXT_HEADER = "x-hirakumi-sign-next";

const iouFor = (c: TryChannel, n: number) => `${n}.${signReceipt(c.secretKey, c.channelId, n)}`;

/**
 * One paid call on an escrow pack. A 402 iou_required is answered once with the IOU the gateway asks for, and
 * only if that many passes were checked. A 200 is checked against the promise: a pass is counted and IOU
 * Sign-Next is signed; a "pass" that breaks the promise is a dispute and nothing more is ever signed.
 */
export async function escrowCall(
  store: TryEscrowStore,
  c: TryChannel,
  send: (iou: string | null) => Promise<Response>,
): Promise<EscrowOutcome> {
  let iou = c.lastIou;
  let res = await send(iou);
  let text = await res.text();
  if (res.status === 402) {
    const body = safeJson(text) as { error?: unknown; signNext?: unknown } | null;
    const wanted = body?.error === "iou_required" ? Number(body.signNext) : NaN;
    if (Number.isSafeInteger(wanted) && wanted >= 1 && wanted <= (await store.verified(c.tryId))) {
      iou = iouFor(c, wanted);
      await store.saveIou(c.tryId, wanted, iou);
      res = await send(iou);
      text = await res.text();
    }
  }
  if (res.status !== 200) return { res, text, iouSigned: null, disputed: false };

  const rule = await store.rule(c.ruleHash);
  const verdict = rule ? compileRule(rule).check({ status: 200, contentType: res.headers.get("content-type"), body: text, latencyMs: 0 }) : null;
  if (!verdict?.pass) {
    await store.dispute(c.tryId);
    return { res, text, iouSigned: null, disputed: true };
  }
  const checked = await store.countPass(c.tryId);
  const n = Number(res.headers.get(SIGN_NEXT_HEADER));
  if (!Number.isSafeInteger(n) || n < 1 || n > checked) return { res, text, iouSigned: null, disputed: false };
  await store.saveIou(c.tryId, n, iouFor(c, n));
  return { res, text, iouSigned: n, disputed: false };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
