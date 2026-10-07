// start_job's per-address limiter under abuse: one address flooding, IPv6 rotation inside a /64, and many
// distinct /64s (a /48 holds 65 536 of them). The limiter is in memory, so it must stay bounded and fast.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LONG, makeHarness, serve, tally, type Harness } from "./kit";

let h: Harness;
let srv: Awaited<ReturnType<typeof serve>>;
beforeAll(async () => { h = await makeHarness(); srv = await serve(h.app); });
afterAll(async () => { await srv?.close(); await h?.close(); });

const start = (xff: string, body = "{}") =>
  srv.req(`/a/${h.seeded.apiId}/start_job`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": xff }, body }).then((r) => r.status);

async function pool<T>(n: number, width: number, f: (i: number) => Promise<T>): Promise<T[]> {
  const out: T[] = new Array(n);
  let i = 0;
  await Promise.all(Array.from({ length: width }, async () => { while (i < n) { const k = i++; out[k] = await f(k); } }));
  return out;
}

describe("start_job limiter", () => {
  it("one address: exactly 10 per minute get through, even 200 at once", async () => {
    const rs = await Promise.all(Array.from({ length: 200 }, () => start("203.0.113.7")));
    expect(tally(rs)).toEqual({ 400: 10, 429: 190 });
  });

  it("rotating IPv6 addresses inside one /64 shares one budget", async () => {
    const rs = await Promise.all(Array.from({ length: 100 }, (_, i) => start(`2001:db8:1:2:${i.toString(16)}::${(i * 7).toString(16)}`)));
    expect(tally(rs)).toEqual({ 400: 10, 429: 90 });
  });

  it("the same address written differently (IPv4-mapped, zero-padded IPv6) shares one budget", async () => {
    const rs = await Promise.all([
      ...Array.from({ length: 10 }, () => start("198.51.100.9")),
      ...Array.from({ length: 10 }, () => start("::ffff:198.51.100.9")),
      ...Array.from({ length: 10 }, () => start("2001:db8:0:0:1::1")),
      ...Array.from({ length: 10 }, () => start("2001:0db8:0000:0000:ffff::2")),
      ...Array.from({ length: 10 }, () => start("2001:DB8::3")),
    ]);
    expect(rs.filter((s) => s === 400).length).toBe(20);
  });

  it("many distinct /64s (a /48 sweep): per-request cost stays flat as the table grows", async () => {
    const N = LONG ? 60_000 : 25_000;
    const times: number[] = [];
    await pool(N, 64, async (i) => {
      const t0 = performance.now();
      await start(`2001:db8:${(i >> 16).toString(16)}:${(i & 0xffff).toString(16)}::1`);
      times.push(performance.now() - t0);
      return 0;
    });
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const first = avg(times.slice(1_000, 3_000));
    const last = avg(times.slice(-2_000));
    console.log(`[stress] start_job limiter: ${N} distinct /64s, avg latency first=${first.toFixed(2)}ms last=${last.toFixed(2)}ms`);
    // A linear scan of the whole table on every request past 10 000 keys shows up as a large slowdown.
    expect(last / first).toBeLessThan(3);
  });
});
