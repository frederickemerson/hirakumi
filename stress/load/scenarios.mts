// Live load and abuse scenarios against a gateway process that run.mjs started on localhost, with the local
// seller (seller.mjs) and the refusing facilitator stub (facilitator.mjs), on a throwaway database.
// Every scenario checks money invariants on the server side (the database), not only the status codes.
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { Pool } from "undici";
import postgres from "postgres";
import { newBearerToken, newId, ruleHash, sha256Hex, type RuleDefinition } from "@hirakumi/core";

const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`run through stress/run.mjs (${k} unset)`); return v; };
const GW = env("STRESS_GW");
const SELLER = env("STRESS_SELLER");
const FAC = env("STRESS_FAC");
const DB = env("STRESS_DB");
const INTERNAL = env("STRESS_INTERNAL_TOKEN");
const GW_PID = Number(env("STRESS_GW_PID"));
const LONG = process.env.STRESS_LONG === "1";
const ONLY = process.env.STRESS_ONLY?.split(",").filter(Boolean) ?? [];
for (const u of [GW, SELLER, FAC, DB]) {
  const host = new URL(u).hostname;
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) throw new Error(`refusing a non-local target: ${u}`);
}
if (!/stress/.test(new URL(DB).pathname)) throw new Error(`refusing a database whose name lacks "stress": ${DB}`);

const sql = postgres(DB, { max: 4, onnotice: () => {} });
const pool = new Pool(GW, { connections: 128, pipelining: 1, keepAliveTimeout: 10_000 });
const results: { name: string; ok: boolean; detail: string; metrics?: Record<string, unknown> }[] = [];
const record = (name: string, ok: boolean, detail: string, metrics?: Record<string, unknown>) => {
  results.push({ name, ok, detail, metrics });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tally = (xs: (string | number)[]) => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
const pct = (sorted: number[], p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : 0;
const rssMb = () => { try { return Number(execFileSync("ps", ["-o", "rss=", "-p", String(GW_PID)]).toString().trim()) / 1024; } catch { return NaN; } };

async function req(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const r = await pool.request({ path, method: (init.method ?? "GET") as "GET", headers: init.headers, body: init.body });
  const text = await r.body.text();
  return { status: r.statusCode, headers: r.headers, text };
}
const admin = (o: Record<string, unknown>) => fetch(`${SELLER}/__admin`, { method: "POST", body: JSON.stringify(o) }).then((r) => r.json());
const internal = (path: string) => fetch(`${GW}${path}`, { method: "POST", headers: { authorization: `Bearer ${INTERNAL}` } });

// ------------------------------------------------------------------ seeding (mirrors apps/gateway/test/helpers.ts)

const PRICE_RULE: RuleDefinition = {
  version: 1, status: { min: 200, max: 299 }, contentType: "application/json",
  schema: { type: "object", required: ["price", "symbol", "updatedAt"], properties: { price: { type: "number" }, symbol: { type: "string" }, updatedAt: { type: "string", maxAgeSeconds: 300 } } },
};
const INPUT = { type: "object", properties: { symbol: { type: "string", minLength: 2, maxLength: 10 } }, required: ["symbol"], additionalProperties: false };

async function seedApi(o: { base?: string; state?: string; priceMicros?: number; calls?: number } = {}) {
  const sellerId = newId("sel"), apiId = newId("api"), opId = newId("op"), ruleId = newId("rule"), packId = newId("pk");
  const base = o.base ?? `/s-${randomBytes(4).toString("hex")}`;
  await sql`insert into sellers (id, cardano_addr) values (${sellerId}, ${`addr_test1q${randomBytes(20).toString("hex")}`})`;
  await sql`insert into apis (id, seller_id, name, origin, path_prefix, openapi_url, state, health, escrow_op_id, agent_identifier, created_at)
            values (${apiId}, ${sellerId}, 'Stress API', ${SELLER}, ${base}, ${`${SELLER}/openapi.json`}, ${o.state ?? "live"}, 'healthy', ${opId}, 'agent_stress', now() - interval '30 days')`;
  await sql`insert into operations (id, api_id, op_id, method, path, input_schema, enabled, side_effects_confirmed_none)
            values (${opId}, ${apiId}, 'getPrice', 'GET', '/price', ${sql.json(INPUT)}, true, true)`;
  await sql`insert into rules (id, operation_id, version, definition, hash, plain_english)
            values (${ruleId}, ${opId}, 1, ${sql.json(PRICE_RULE as never)}, ${ruleHash(PRICE_RULE)}, 'stress')`;
  await sql`insert into packs (id, api_id, calls, price_micros, escrow_price_micros) values (${packId}, ${apiId}, ${o.calls ?? 100}, ${o.priceMicros ?? 2_000_000}, 1000000)`;
  await sql`insert into test_inputs (id, operation_id, input) values (${newId("ti")}, ${opId}, ${sql.json({ symbol: "ADA" })})`;
  return { apiId, packId, opId, base, call: `/a/${apiId}/x/getPrice?symbol=ADA` };
}
async function newToken(apiId: string, packId: string, remaining: number) {
  const token = newBearerToken();
  const id = newId("ct");
  await sql`insert into credit_tokens (id, api_id, pack_id, token_hash, status, remaining, payment_payload_hash)
            values (${id}, ${apiId}, ${packId}, ${sha256Hex(token)}, 'active', ${remaining}, ${"stress-" + id})`;
  return { token, id };
}
const remainingOf = async (id: string) => (await sql<{ remaining: number; status: string }[]>`select remaining, status from credit_tokens where id = ${id}`)[0]!;

/** Closed-loop load: `conns` workers each send the next request as soon as the last one answers. */
async function drive(o: { conns: number; durationMs?: number; total?: number; make: (i: number) => { path: string; headers?: Record<string, string>; method?: string } }) {
  const lat: number[] = [];
  const st: Record<string, number> = {};
  let i = 0, errors = 0;
  const t0 = performance.now();
  const until = o.durationMs ? t0 + o.durationMs : Infinity;
  const rss: number[] = [rssMb()];
  const sampler = setInterval(() => rss.push(rssMb()), 1_000);
  await Promise.all(Array.from({ length: o.conns }, async () => {
    while (performance.now() < until && (o.total === undefined || i < o.total)) {
      const r = o.make(i++);
      const a = performance.now();
      try {
        const res = await pool.request({ path: r.path, method: (r.method ?? "GET") as "GET", headers: r.headers });
        await res.body.dump();
        st[res.statusCode] = (st[res.statusCode] ?? 0) + 1;
      } catch { errors += 1; }
      lat.push(performance.now() - a);
    }
  }));
  clearInterval(sampler);
  rss.push(rssMb());
  const secs = (performance.now() - t0) / 1000;
  lat.sort((a, b) => a - b);
  return {
    requests: lat.length, seconds: +secs.toFixed(1), rps: Math.round(lat.length / secs), statuses: st, errors,
    p50: +pct(lat, 50).toFixed(1), p90: +pct(lat, 90).toFixed(1), p99: +pct(lat, 99).toFixed(1), max: +(lat[lat.length - 1] ?? 0).toFixed(1),
    rssStartMb: Math.round(rss[0]!), rssEndMb: Math.round(rss[rss.length - 1]!), rssPeakMb: Math.round(Math.max(...rss.filter(Number.isFinite))), rss,
  };
}
async function waitHealth(apiId: string, code: number, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const r = await req(`/a/${apiId}/availability`);
    if (r.status === code) return true;
    await sleep(1_000);
  }
  return false;
}
const want = (name: string) => ONLY.length === 0 || ONLY.some((o) => name.toLowerCase().includes(o.toLowerCase()));

// ------------------------------------------------------------------ scenarios

await admin({ mode: "ok", verify: null });
const main = await seedApi();
await internal(`/internal/apis/${main.apiId}/reload`);

if (want("throughput")) {
  // Credit path at full speed; every 200 must have used exactly one credit, every credit a recorded pass.
  const credits = 10_000_000;
  const { token, id } = await newToken(main.apiId, main.packId, credits);
  const m = await drive({ conns: 64, durationMs: LONG ? 120_000 : 20_000, make: () => ({ path: main.call, headers: { authorization: `Bearer ${token}` } }) });
  await sleep(500);
  const used = credits - (await remainingOf(id)).remaining;
  const [{ passes }] = await sql<{ passes: number }[]>`select count(*)::int as passes from calls where credit_token_id = ${id} and verdict = 'pass'`;
  const ok200 = m.statuses[200] ?? 0;
  const { rss, ...shown } = m;
  record("throughput: credits used == 200s == pass rows; no errors", used === ok200 && used === passes && m.errors === 0 && Object.keys(m.statuses).every((k) => k === "200"),
    `used=${used} 200s=${ok200} passRows=${passes} ${JSON.stringify(shown)}`, { ...shown, rssSamples: rss.length });
}

if (want("soak")) {
  // Memory over many calls of every kind (paid, unpaid offers, bad tokens, receipts, 404s): RSS must level off.
  const { token } = await newToken(main.apiId, main.packId, 10_000_000);
  const total = LONG ? 300_000 : 60_000;
  const kinds = [
    () => ({ path: main.call, headers: { authorization: `Bearer ${token}` } }),
    () => ({ path: main.call }),
    () => ({ path: main.call, headers: { authorization: `Bearer ${newBearerToken()}` } }),
    () => ({ path: `/a/${main.apiId}/receipts`, headers: { authorization: `Bearer ${token}` } }),
    () => ({ path: `/a/${main.apiId}/x/getPrice?symbol=${randomBytes(3).toString("hex")}`, headers: { authorization: `Bearer ${token}` } }),
    () => ({ path: `/a/api_${randomBytes(5).toString("hex")}/x/getPrice?symbol=ADA` }),
    () => ({ path: `/a/${main.apiId}/availability` }),
    () => ({ path: `/a/${main.apiId}/packs/${main.packId}`, method: "POST" }),
  ];
  const weights = [10, 3, 2, 0, 3, 2, 2, 1]; // receipts are heavy (they list every call): exercised in their own scenario
  const pick: (() => { path: string; headers?: Record<string, string>; method?: string })[] = kinds.flatMap((k, i) => Array(weights[i]).fill(k));
  const m = await drive({ conns: 64, total, make: (i) => pick[i % pick.length]!() });
  const half = m.rss.slice(Math.floor(m.rss.length / 2)).filter(Number.isFinite);
  const growthSecondHalf = half.length > 1 ? half[half.length - 1]! - half[0]! : 0;
  const fives = Object.entries(m.statuses).filter(([k]) => k.startsWith("5")).reduce((a, [, v]) => a + v, 0);
  const { rss, ...shown } = m;
  // The gateway runs with a 256 MB old-space cap (run.mjs): a leak ends in an out-of-memory crash, seen here as errors.
  // RSS itself moves with the GC, so it is reported, with only a loose ceiling.
  const alive = (await req("/healthz")).status === 200;
  record(`soak: ${total} mixed calls under a 256 MB heap cap: no 5xx, no errors, still alive, RSS < 700 MB`, fives === 0 && m.errors === 0 && alive && m.rssPeakMb < 700,
    `secondHalfGrowthMb=${Math.round(growthSecondHalf)} ${JSON.stringify(shown)}`, { ...shown, rssMb: rss.map(Math.round) });
}

if (want("race")) {
  const tokens = await Promise.all(Array.from({ length: 50 }, () => newToken(main.apiId, main.packId, 2)));
  const rs = await Promise.all(tokens.flatMap((t) => Array.from({ length: 10 }, () => req(main.call, { headers: { authorization: `Bearer ${t.token}` } }).then((r) => `${t.id}:${r.status}`))));
  const per = tally(rs.filter((x) => x.endsWith(":200")).map((x) => x.split(":")[0]!));
  const after = await Promise.all(tokens.map((t) => remainingOf(t.id)));
  record("last-credit race: 50 tokens x 2 credits x 10 callers -> exactly 2 x 200 each, all exhausted",
    Object.keys(per).length === 50 && Object.values(per).every((n) => n === 2) && after.every((a) => a.remaining === 0 && a.status === "exhausted"),
    `tokensWith2=${Object.values(per).filter((n) => n === 2).length} statuses=${JSON.stringify(tally(rs.map((x) => x.split(":")[1]!)))}`);
}

if (want("receipts")) {
  // A token with many calls: receipts lists them all. How long does that take, and does it hold the server up?
  const { token } = await newToken(main.apiId, main.packId, 100_000);
  await drive({ conns: 32, total: LONG ? 20_000 : 5_000, make: () => ({ path: main.call, headers: { authorization: `Bearer ${token}` } }) });
  const t0 = performance.now();
  const r = await req(`/a/${main.apiId}/receipts`, { headers: { authorization: `Bearer ${token}` } });
  const ms = Math.round(performance.now() - t0);
  const listed = JSON.parse(r.text).calls?.length ?? -1;
  const concurrent = await drive({ conns: 16, total: 64, make: () => ({ path: `/a/${main.apiId}/receipts`, headers: { authorization: `Bearer ${token}` } }) });
  record("receipts of a heavily used token: answered, size and time reported", r.status === 200,
    `listed=${listed} bytes=${r.text.length} ms=${ms} concurrent64: p50=${concurrent.p50}ms p99=${concurrent.p99}ms rssPeak=${concurrent.rssPeakMb}MB`,
    { listed, bytes: r.text.length, ms, p99: concurrent.p99 });
}

if (want("chaos")) {
  // The seller flips pass/fail on every call while buyers hammer it: credits used == 200s exactly. Each token makes
  // 20 calls, so none reaches the gateway's limit of 20 failed calls a minute (a token past it gets 429s).
  const api = await seedApi();
  await internal(`/internal/apis/${api.apiId}/reload`);
  const total = LONG ? 50_000 : 10_000;
  const tokens = await Promise.all(Array.from({ length: total / 20 }, () => newToken(api.apiId, api.packId, 1_000)));
  await admin({ mode: "flip" });
  const m = await drive({ conns: 64, total, make: (i) => ({ path: api.call, headers: { authorization: `Bearer ${tokens[i % tokens.length]!.token}` } }) });
  await admin({ mode: "ok" });
  const [{ left }] = await sql<{ left: number }[]>`select sum(remaining)::int as left from credit_tokens where id = any(${tokens.map((t) => t.id)})`;
  const used = tokens.length * 1_000 - left!;
  record("flip-flopping seller under load: credits used == 200s, the rest 422", used === (m.statuses[200] ?? 0) && Object.keys(m.statuses).every((k) => k === "200" || k === "422" || k === "503"),
    `used=${used} statuses=${JSON.stringify(m.statuses)} p99=${m.p99}ms`);
  await waitHealth(api.apiId, 200);
}

if (want("down")) {
  // Broken seller: 422 and no credit; the monitor flips it Down (503, no credit, no upstream call); recovery.
  // The broken calls use their own token: past 20 failed calls in a minute it gets 429s (no credit either), and the
  // recovery call must not wait out that minute.
  const api = await seedApi();
  await internal(`/internal/apis/${api.apiId}/reload`);
  const { token, id } = await newToken(api.apiId, api.packId, 500);
  const broken = await newToken(api.apiId, api.packId, 500);
  await admin({ mode: "empty" });
  const r1 = await Promise.all(Array.from({ length: 300 }, () => req(api.call, { headers: { authorization: `Bearer ${broken.token}` } }).then((r) => r.status)));
  const down = await waitHealth(api.apiId, 503);
  const r2 = await Promise.all(Array.from({ length: 200 }, () => req(api.call, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.status)));
  const offerDown = await req(`/a/${api.apiId}/packs/${api.packId}`, { method: "POST" });
  await admin({ mode: "ok" });
  const up = await waitHealth(api.apiId, 200);
  const r3 = await req(api.call, { headers: { authorization: `Bearer ${token}` } });
  const left = (await remainingOf(id)).remaining;
  const brokenLeft = (await remainingOf(broken.id)).remaining;
  record("broken -> Down -> recovered: 422s and 503s use nothing, no pack is offered while Down, one credit after recovery",
    r1.every((s) => s === 422 || s === 429) && brokenLeft === 500 && down && r2.every((s) => s === 503) && offerDown.status === 503 && up && r3.status === 200 && left === 499,
    `broken=${JSON.stringify(tally(r1))} down=${down} whileDown=${JSON.stringify(tally(r2))} packOffer=${offerDown.status} recovered=${up} after=${r3.status} left=${left} brokenLeft=${brokenLeft}`);
}

if (want("hybrid")) {
  // 30 buyers x 10 concurrent 402s with escrow keys: one stable offer per buyer, and their paid retries all reach the
  // facilitator (matched), which refuses: no token, no channel. Forged mode / dropped keys are refused before it.
  const BUYER = "addr_test1qzcmrvd3kxcmrvd3kxcmrvd3kxcmrvd3kxcmrvd3kxcmrvd4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kk6sfs370w";
  const keys = () => ({ "x-hirakumi-receipt-key": Buffer.from(generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x!, "base64url").toString("hex"), "x-hirakumi-refund-address": BUYER });
  const decode = (h: unknown) => JSON.parse(Buffer.from(String(h), "base64").toString("utf8"));
  const pack = `/a/${main.apiId}/packs/${main.packId}`;
  const verifies = async () => ((await (await fetch(`${FAC}/count`)).json()) as { verifies: number }).verifies;
  const t0 = await sql<{ n: number }[]>`select count(*)::int as n from credit_tokens where payment_payload_hash not like 'stress-%'`;
  const buyers = Array.from({ length: 30 }, keys);
  const offers = await Promise.all(buyers.flatMap((k) => Array.from({ length: 10 }, () => req(pack, { method: "POST", headers: k }).then((r) => ({ k, r })))));
  const per = new Map<object, Set<string>>();
  for (const { k, r } of offers) { const s = per.get(k) ?? new Set(); s.add(JSON.stringify(decode(r.headers["payment-required"]).accepts[0])); per.set(k, s); }
  const unstable = [...per.values()].filter((s) => s.size !== 1).length;
  const v0 = await verifies();
  const pay = async (k: Record<string, string> | null, accepted: Record<string, unknown>, required: Record<string, unknown>) => {
    const sig = Buffer.from(JSON.stringify({ x402Version: required.x402Version, resource: required.resource, accepted, payload: { transaction: `stress-${randomBytes(6).toString("hex")}` } })).toString("base64");
    const r = await req(pack, { method: "POST", headers: { ...(k ?? {}), "payment-signature": sig } });
    const err = r.headers["payment-required"] ? decode(r.headers["payment-required"]).error ?? "" : `status ${r.status}`;
    return /stress_stub_verify/.test(err) ? "matched" : /No matching payment requirements/i.test(err) ? "mismatch" : `other:${r.status}`;
  };
  const paid = await Promise.all(buyers.flatMap((k) => {
    const req0 = decode(offers.find((o) => o.k === k)!.r.headers["payment-required"]);
    return Array.from({ length: 3 }, () => pay(k, req0.accepts[0], req0));
  }));
  const v1 = await verifies();
  const forged = await Promise.all(buyers.slice(0, 10).flatMap((k) => {
    const req0 = decode(offers.find((o) => o.k === k)!.r.headers["payment-required"]);
    const a = req0.accepts[0];
    return [
      // (Another buyer's keys: a direct offer does not depend on the buyer, so that one is checked separately below.)
      pay(null, a, req0),
      pay(k, { ...a, extra: { ...a.extra, settlement: { mode: "escrow", reasons: ["large pack"] } } }, req0),
      pay(k, { ...a, amount: String(BigInt(a.amount) - 1n) }, req0),
    ];
  }));
  const v2 = await verifies();
  // Escrow offers name the buyer's channel; a direct offer is the same for every buyer, so paying it with other keys is fine.
  const swapped = await Promise.all(buyers.slice(0, 10).map((k) => {
    const req0 = decode(offers.find((o) => o.k === k)!.r.headers["payment-required"]);
    return pay(keys(), req0.accepts[0], req0).then((r) => `${req0.accepts[0].extra.settlement.mode}:${r}`);
  }));
  const v3 = await verifies();
  const t1 = await sql<{ n: number }[]>`select count(*)::int as n from credit_tokens where payment_payload_hash not like 'stress-%'`;
  record("hybrid: 300 concurrent 402s -> one stable offer per buyer; 90 paid retries all match; 30 forged ones never reach the facilitator; no token",
    unstable === 0 && tally(paid).matched === 90 && v1 - v0 === 90 && tally(forged).mismatch === 30 && v2 === v1 && swapped.every((x) => x === "direct:matched" || x === "escrow:mismatch") && t1[0]!.n === t0[0]!.n,
    `unstable=${unstable} paid=${JSON.stringify(tally(paid))} forged=${JSON.stringify(tally(forged))} otherKeys=${JSON.stringify(tally(swapped))}(+${v3 - v2} verifies) verifies=+${v1 - v0}/+${v2 - v1} tokens=${t0[0]!.n}->${t1[0]!.n}`);
}

if (want("ownership")) {
  // A live API proven with the header. Buyers hammer it while the header goes away (two misses pause new sales,
  // paid calls keep working) and comes back. Re-checks run on the monitor's tick (10 s in demo mode).
  const api = await seedApi();
  const code = `hkv_${randomBytes(32).toString("base64url")}`;
  await sql`insert into challenges (id, api_id, kind, token, expires_at, consumed_at, proof)
            values (${newId("ch")}, ${api.apiId}, 'header', ${code}, now() + interval '1 year', now(), ${sql.json({ passedAt: new Date().toISOString() })})`;
  const { token, id } = await newToken(api.apiId, api.packId, 1_000_000);
  await internal(`/internal/apis/${api.apiId}/reload`);
  const due = () => sql`update apis set ownership_next_check_at = now() - interval '1 second' where id = ${api.apiId}`;
  const state = async () => (await sql<{ p: Date | null; f: number }[]>`select ownership_paused_at as p, ownership_failures as f from apis where id = ${api.apiId}`)[0]!;
  let stop = false;
  const offer: Record<string, number> = {}, paidT: Record<string, number> = {};
  const load = (async () => {
    while (!stop) {
      const b = await Promise.all([
        ...Array.from({ length: 16 }, () => req(api.call).then((r) => `${r.status}:${r.status === 503 ? JSON.parse(r.text).error : ""}`)),
        ...Array.from({ length: 16 }, () => req(api.call, { headers: { authorization: `Bearer ${token}` } }).then((r) => String(r.status))),
      ]);
      b.slice(0, 16).forEach((s) => { offer[s] = (offer[s] ?? 0) + 1; });
      b.slice(16).forEach((s) => { paidT[s] = (paidT[s] ?? 0) + 1; });
    }
  })();
  // Each re-check needs the API's entry in the registry refreshed to show the pause: the monitor reloads it.
  const tick = async () => { await due(); await sleep(12_000); };
  await admin({ verify: code }); await tick(); const a = await state();
  await admin({ verify: null }); await tick(); const b = await state();
  await tick(); const c = await state();
  const pausedOffer = await req(api.call);
  const pausedPaid = await req(api.call, { headers: { authorization: `Bearer ${token}` } });
  // Flapping: header on, off, on, off quickly while checks keep coming.
  for (let i = 0; i < 4; i++) { await admin({ verify: i % 2 ? null : code }); await due(); await sleep(3_000); }
  await admin({ verify: code }); await tick(); const d = await state();
  const backOffer = await req(api.call);
  stop = true; await load;
  const used = 1_000_000 - (await remainingOf(id)).remaining;
  const [{ passes }] = await sql<{ passes: number }[]>`select count(*)::int as passes from calls where credit_token_id = ${id} and verdict = 'pass'`;
  const offersOk = Object.keys(offer).every((k) => k === "402:" || k === "503:selling_paused");
  record("ownership: 1 miss no pause; 2 misses pause new sales (paid calls still 200); flapping settles; header back restores; credits used == passes",
    a.p === null && b.p === null && b.f === 1 && c.p !== null && pausedOffer.status === 503 && pausedPaid.status === 200 && d.p === null && backOffer.status === 402
      && offersOk && Object.keys(paidT).every((k) => k === "200") && used === passes,
    `afterPass=${a.f} afterOne=${b.f}/${b.p ? "paused" : "selling"} afterTwo=${c.p ? "paused" : "selling"} paused402=${pausedOffer.status} pausedPaid=${pausedPaid.status} restored=${d.p === null}/${backOffer.status} offers=${JSON.stringify(offer)} paid=${JSON.stringify(paidT)} used=${used} passes=${passes}`);
}

await pool.close();
await sql.end();
const failed = results.filter((r) => !r.ok);
console.log(`\nLIVE ${results.length - failed.length}/${results.length} passed`);
console.log(`STRESS_RESULTS ${JSON.stringify(results.map(({ name, ok, metrics }) => ({ name, ok, metrics })))}`);
process.exit(failed.length ? 1 : 0);
