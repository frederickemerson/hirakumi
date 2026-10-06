export type Logger = Pick<Console, "error" | "info">;

/** Runs fn every intervalMs; skips a tick while the previous run is still going; logs, never throws. */
export function startLoop(name: string, intervalMs: number, fn: () => Promise<unknown>, log: Logger = console): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (e) {
      log.error(`[${name}] ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  return () => clearInterval(timer);
}
