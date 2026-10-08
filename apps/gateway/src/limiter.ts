/**
 * Sliding-window limiter per key. The map is kept in last-request order (a key is moved to the end on every request),
 * so addresses whose newest request left the window sit at the front and are dropped there: O(1) amortised per
 * request however many addresses are live. (A full scan once the map passed 10 000 keys made every request cost
 * O(addresses): a sweep over many IPv6 /64s slowed every caller down.)
 */
export function createWindowLimiter(max: number, windowMs: number): (key: string, now?: number) => boolean {
  const hits = new Map<string, number[]>();
  return (key, now = Date.now()) => {
    for (const [k, v] of hits) {
      if (now - v[v.length - 1]! < windowMs) break;
      hits.delete(k);
    }
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    hits.delete(key);
    if (recent.length >= max) { hits.set(key, recent); return false; }
    recent.push(now);
    hits.set(key, recent);
    return true;
  };
}

export type FailureCounter = {
  /** Null while the key has fewer than `max` failures in the window; otherwise the seconds until one leaves it. */
  blocked(key: string, now?: number): { retryAfter: number } | null;
  /** Records one failure for the key. */
  hit(key: string, now?: number): void;
  /**
   * Starts a call that may fail. Recorded failures plus calls still running never pass `max`: when the recorded
   * failures alone reach it the answer is the blocked one, and when running calls make up the rest it waits for one
   * of them to end, at most `maxWaitMs` (then it is refused too, with retryAfter 1). Call end() once the call is over;
   * a failed call is recorded then.
   */
  begin(key: string, maxWaitMs?: number): Promise<{ retryAfter: number } | { end(passed: boolean): void }>;
};

/**
 * Counts failures per key in a sliding window. Unlike createWindowLimiter, asking never counts: only hit() does, so
 * a caller can check before the work and record after it, once it knows the work failed. begin() also counts calls
 * still running, so many calls started at once can't all slip under the limit; past it they wait their turn instead
 * of being refused, so a busy key whose calls pass is only slowed, never refused. The map is kept in last-hit order
 * and only the newest `max` times are kept per key, so memory stays bounded the same way.
 */
/** begin() waits at most this long by default: below an escrow call's 30 s lease and any client's patience. */
const FAILURE_WAIT_MS = 5_000;

/**
 * In memory, so per gateway process: this deployment runs one gateway (Caddyfile reverse_proxy gateway:4021). With
 * several, each would allow `max` failures per window, which only loosens the bound.
 */
export function createFailureCounter(max: number, windowMs: number): FailureCounter {
  const hits = new Map<string, number[]>();
  const running = new Map<string, number>();
  const waiting = new Map<string, (() => void)[]>();
  const recent = (key: string, now: number): number[] => {
    for (const [k, v] of hits) {
      if (now - v[v.length - 1]! < windowMs) break;
      hits.delete(k);
    }
    return (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  };
  const blocked = (key: string, now = Date.now()) => {
    const times = recent(key, now);
    if (times.length < max) return null;
    const freesAt = times[times.length - max]! + windowMs;
    return { retryAfter: Math.max(1, Math.ceil((freesAt - now) / 1000)) };
  };
  const hit = (key: string, now = Date.now()) => {
    const times = recent(key, now);
    times.push(now);
    hits.delete(key);
    hits.set(key, times.slice(-max));
  };
  // Wakes as many waiters as there are free places, or all of them once the key is blocked (they are refused then).
  // A waiter only waits while some call on its key is running, so an end() always comes to wake it.
  const wake = (key: string) => {
    const queue = waiting.get(key);
    if (!queue) return;
    const failed = recent(key, Date.now()).length;
    const free = failed >= max ? queue.length : max - failed - (running.get(key) ?? 0);
    for (const resolve of queue.splice(0, Math.max(0, free))) resolve();
    if (!queue.length) waiting.delete(key);
  };
  const begin = async (key: string, maxWaitMs = FAILURE_WAIT_MS) => {
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      const tooMany = blocked(key);
      if (tooMany) return tooMany;
      if (recent(key, Date.now()).length + (running.get(key) ?? 0) < max) break;
      // Never hold the caller's reserved credit (and an escrow lease) for long: past the deadline, refuse.
      const left = deadline - Date.now();
      if (left <= 0) return { retryAfter: 1 };
      let wakeUp!: () => void;
      let timer: NodeJS.Timeout | undefined;
      const woke = await new Promise<boolean>((resolve) => {
        wakeUp = () => resolve(true);
        waiting.set(key, [...(waiting.get(key) ?? []), wakeUp]);
        timer = setTimeout(() => resolve(false), left);
      });
      clearTimeout(timer);
      if (!woke) {
        const queue = (waiting.get(key) ?? []).filter((r) => r !== wakeUp);
        if (queue.length) waiting.set(key, queue);
        else waiting.delete(key);
        return { retryAfter: 1 };
      }
    }
    running.set(key, (running.get(key) ?? 0) + 1);
    let ended = false;
    return {
      end(passed: boolean) {
        if (ended) return;
        ended = true;
        const left = running.get(key)! - 1;
        if (left) running.set(key, left);
        else running.delete(key);
        if (!passed) hit(key);
        wake(key);
      },
    };
  };
  return { blocked, hit, begin };
}
