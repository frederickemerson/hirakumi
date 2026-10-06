import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

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
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
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
