import { ruleHash, type RuleDefinition } from "@hirakumi/core";
import { newReceiptKey, verifyReceipt } from "@hirakumi/escrow/iou";
import { describe, expect, it } from "vitest";
import { escrowCall, type TryChannel, type TryEscrowStore } from "./try-escrow";

const RULE: RuleDefinition = {
  version: 1, status: { min: 200, max: 299 }, contentType: "application/json",
  schema: { type: "object", required: ["usd"], properties: { usd: { type: "number" } } },
} as RuleDefinition;
const CHANNEL_ID = "ab".repeat(32);

/** In-memory IOU state, like the try_tokens row. */
function memoryStore(verified = 0, rule: RuleDefinition = RULE) {
  const s = { verified, signed: 0, last: null as string | null, disputed: false };
  const store: TryEscrowStore = {
    rule: async (hash) => (hash === ruleHash(rule) ? rule : null),
    countPass: async () => (s.verified += 1),
    verified: async () => s.verified,
    saveIou: async (_id, n, iou) => { if (n > s.signed) { s.signed = n; s.last = iou; } },
    dispute: async () => { s.disputed = true; },
  };
  return { s, store };
}

function channel(lastIou: string | null = null, rule: RuleDefinition = RULE) {
  const key = newReceiptKey();
  const c: TryChannel = { tryId: "try_1", channelId: CHANNEL_ID, secretKey: key.secretKey, ruleHash: ruleHash(rule), lastIou };
  return { c, publicKey: key.publicKey };
}

const ok = (body: string, signNext: number | null) => new Response(body, {
  status: 200, headers: { "content-type": "application/json", ...(signNext === null ? {} : { "x-hirakumi-sign-next": String(signNext) }) },
});
const iouRequired = (signNext: number) => new Response(JSON.stringify({ error: "iou_required", signNext }), { status: 402 });

/** Answers in order and records the IOU header of each request. */
function gateway(...replies: Response[]) {
  const sent: (string | null)[] = [];
  return { sent, send: async (iou: string | null) => { sent.push(iou); return replies.shift()!; } };
}

const verifies = (publicKey: string, iou: string | null, n: number) => {
  const [count, sig] = (iou ?? "").split(".");
  return Number(count) === n && verifyReceipt(publicKey, CHANNEL_ID, n, sig ?? "");
};

describe("escrowCall (Try it live on an escrow pack)", () => {
  it("checks a pass against the promise, then signs the IOU the gateway asks for", async () => {
    const { s, store } = memoryStore();
    const { c, publicKey } = channel();
    const g = gateway(ok('{"usd":0.27}', 1));
    const out = await escrowCall(store, c, g.send);
    expect(out).toMatchObject({ iouSigned: 1, disputed: false });
    expect(out.res.status).toBe(200);
    expect(g.sent).toEqual([null]);
    expect(s.verified).toBe(1);
    expect(verifies(publicKey, s.last, 1)).toBe(true);
  });

  it("checks a text answer (CSV) against a text promise", async () => {
    const csv: RuleDefinition = { version: 1, status: { min: 200, max: 299 }, contentType: "text/csv", schema: { type: "string", minLength: 1, pattern: "^date,usd\\r?\\n" } };
    const { s, store } = memoryStore(0, csv);
    const { c } = channel(null, csv);
    const answer = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/csv; charset=utf-8", "x-hirakumi-sign-next": "1" } });
    expect(await escrowCall(store, c, gateway(answer("date,usd\n2026-10-07,0.27\n")).send)).toMatchObject({ iouSigned: 1, disputed: false });
    expect(s.verified).toBe(1);
    expect(await escrowCall(store, c, gateway(answer("oops\n")).send)).toMatchObject({ iouSigned: null, disputed: true });
  });

  it("sends the latest IOU with the next call", async () => {
    const { store } = memoryStore(1);
    const { c } = channel("1.sig");
    const g = gateway(ok('{"usd":0.27}', 2));
    await escrowCall(store, c, g.send);
    expect(g.sent).toEqual(["1.sig"]);
  });

  it("answers 402 iou_required once, with an IOU for passes it already checked", async () => {
    const { s, store } = memoryStore(2);
    const { c, publicKey } = channel();
    const g = gateway(iouRequired(2), ok('{"usd":1}', 3));
    const out = await escrowCall(store, c, g.send);
    expect(g.sent).toHaveLength(2);
    expect(verifies(publicKey, g.sent[1], 2)).toBe(true);
    expect(out).toMatchObject({ iouSigned: 3 });
    expect(s.signed).toBe(3);
  });

  it("never signs for more passes than it checked", async () => {
    const { s, store } = memoryStore(1);
    const { c } = channel();
    const g = gateway(iouRequired(5));
    const out = await escrowCall(store, c, g.send);
    expect(out.res.status).toBe(402);
    expect(g.sent).toHaveLength(1);
    expect(s.signed).toBe(0);

    const g2 = gateway(ok('{"usd":1}', 7));
    expect(await escrowCall(store, c, g2.send)).toMatchObject({ iouSigned: null });
    expect(s.signed).toBe(0);
  });

  it("disputes a 'pass' that breaks the promise and signs nothing", async () => {
    const { s, store } = memoryStore();
    const { c } = channel();
    const out = await escrowCall(store, c, gateway(ok('{"price":"oops"}', 1)).send);
    expect(out).toMatchObject({ iouSigned: null, disputed: true });
    expect(s).toMatchObject({ disputed: true, verified: 0, signed: 0 });
  });

  it("disputes when the promise the lock names can't be found, rather than trusting the answer", async () => {
    const { s, store } = memoryStore();
    const { c } = channel();
    const out = await escrowCall(store, { ...c, ruleHash: "sha256:" + "00".repeat(32) }, gateway(ok('{"usd":1}', 1)).send);
    expect(out.disputed).toBe(true);
    expect(s.signed).toBe(0);
  });

  it("signs nothing for a refusal (422, 503) and passes it through", async () => {
    const { s, store } = memoryStore();
    const { c } = channel();
    const out = await escrowCall(store, c, gateway(new Response('{"error":"promise_not_met"}', { status: 422 })).send);
    expect(out).toMatchObject({ iouSigned: null, disputed: false });
    expect(out.res.status).toBe(422);
    expect(s).toMatchObject({ verified: 0, signed: 0 });
  });
});
