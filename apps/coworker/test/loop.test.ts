import { afterEach, describe, expect, it, vi } from "vitest";
import { startLoop } from "../src/loop.js";

afterEach(() => vi.useRealTimers());

describe("startLoop", () => {
  it("never overlaps runs and logs errors instead of throwing", async () => {
    vi.useFakeTimers();
    const log = { error: vi.fn(), info: vi.fn() };
    let release!: () => void;
    const fn = vi.fn(() => new Promise<void>((r) => (release = r)));
    const stop = startLoop("t", 100, fn, log);
    await vi.advanceTimersByTimeAsync(350);
    expect(fn).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(2);
    fn.mockRejectedValueOnce(new Error("boom"));
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(log.error).toHaveBeenCalledWith("[t] boom");
    stop();
  });
});
