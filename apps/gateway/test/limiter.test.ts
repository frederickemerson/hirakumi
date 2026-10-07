import { describe, expect, it } from "vitest";
import { createFailureCounter, createWindowLimiter } from "../src/limiter";

describe("createWindowLimiter", () => {
  it("allows max requests per key in the window, then refuses until the window moves on", () => {
    const allow = createWindowLimiter(2, 1_000);
    expect([allow("a", 0), allow("a", 10), allow("a", 20)]).toEqual([true, true, false]);
    expect(allow("b", 20)).toBe(true);
    expect(allow("a", 1_001)).toBe(true);
  });
});

describe("createFailureCounter", () => {
  it("asking never counts; only hits do", () => {
    const c = createFailureCounter(2, 60_000);
    for (let i = 0; i < 5; i++) expect(c.blocked("t", i)).toBeNull();
    c.hit("t", 0);
    expect(c.blocked("t", 1)).toBeNull();
    c.hit("t", 1);
    expect(c.blocked("t", 2)).not.toBeNull();
  });

  it("blocks at max failures, says when one leaves the window, and frees the key then", () => {
    const c = createFailureCounter(3, 60_000);
    c.hit("t", 0); c.hit("t", 10_000); c.hit("t", 20_000);
    expect(c.blocked("t", 30_000)).toEqual({ retryAfter: 30 });
    expect(c.blocked("t", 59_999)).toEqual({ retryAfter: 1 });
    expect(c.blocked("t", 60_000)).toBeNull();
  });

  it("keeps keys apart and forgets keys whose failures all left the window", () => {
    const c = createFailureCounter(1, 1_000);
    c.hit("a", 0);
    expect(c.blocked("a", 500)).toEqual({ retryAfter: 1 });
    expect(c.blocked("b", 500)).toBeNull();
    c.hit("b", 5_000);
    expect(c.blocked("a", 5_000)).toBeNull();
    expect(c.blocked("b", 5_000)).not.toBeNull();
  });

  it("past max, more hits only push the wait to the newest kept failures", () => {
    const c = createFailureCounter(2, 60_000);
    for (let t = 0; t < 10; t++) c.hit("t", t * 1_000);
    // The newest two are at 8 s and 9 s, so the key frees at 68 s.
    expect(c.blocked("t", 10_000)).toEqual({ retryAfter: 58 });
    expect(c.blocked("t", 68_000)).toBeNull();
  });

  it("begin counts running calls: past the limit it waits for one to end, and is refused if that one failed", async () => {
    const c = createFailureCounter(2, 60_000);
    const a = await c.begin("t");
    const b = await c.begin("t");
    if (!("end" in a) || !("end" in b)) throw new Error("expected both to start");
    let third: Awaited<ReturnType<typeof c.begin>> | null = null;
    const waiting = c.begin("t").then((r) => { third = r; });
    await Promise.resolve();
    expect(third).toBeNull();
    a.end(true); a.end(true);
    await waiting;
    expect(third && "end" in third).toBe(true);
    b.end(false);
    if (third && "end" in third) (third as { end(passed: boolean): void }).end(false);
    expect(c.blocked("t")).not.toBeNull();
    expect(await c.begin("t")).toHaveProperty("retryAfter");
  });

  it("waiters are refused, not left hanging, when the running calls fail", async () => {
    const c = createFailureCounter(2, 60_000);
    const a = await c.begin("t");
    const b = await c.begin("t");
    const waiters = Promise.all([c.begin("t"), c.begin("t"), c.begin("t")]);
    if ("end" in a) a.end(false);
    if ("end" in b) b.end(false);
    expect((await waiters).every((r) => "retryAfter" in r)).toBe(true);
  });
});
