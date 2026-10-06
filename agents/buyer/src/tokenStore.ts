import { readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Writes JSON atomically with owner-only permissions. The temp file gets a fresh random name and is created
 * exclusively, so a leftover (possibly world-readable) file is never reused. The final file is chmod'ed 0600
 * as well, so an older 0644 file is tightened on the next write.
 */
export function writePrivateJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600, flag: "wx" });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  chmodSync(path, 0o600);
  // The fixed-name temp file older versions used: never reused, removed if left over.
  try { rmSync(`${path}.tmp`, { force: true }); } catch { /* best effort */ }
}

export type StoredToken = { token: string; packId: string; credits: number; txHash: string | null; boughtAt: string };
/** A signed pack payment whose settlement failed or timed out: presenting it to /recover re-issues the token. */
export type PendingPayment = { packId: string; paymentSignature: string; recoverySecret: string; at: string };

/** One JSON object per file, keyed by apiId, written atomically with owner-only permissions. */
class JsonStore<T> {
  constructor(private readonly path: string) {}

  private readAll(): Record<string, T> {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, T>;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw e;
    }
  }

  private writeAll(all: Record<string, T>): void {
    writePrivateJson(this.path, all);
  }

  get(apiId: string): T | undefined {
    return this.readAll()[apiId];
  }

  put(apiId: string, t: T): void {
    const all = this.readAll();
    all[apiId] = t;
    this.writeAll(all);
  }

  delete(apiId: string): void {
    const all = this.readAll();
    delete all[apiId];
    this.writeAll(all);
  }
}

export class TokenStore extends JsonStore<StoredToken> {}
export class PendingStore extends JsonStore<PendingPayment> {}
