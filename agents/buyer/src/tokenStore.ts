import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

export type StoredToken = { token: string; packId: string; credits: number; txHash: string | null; boughtAt: string };

export class TokenStore {
  constructor(private readonly path: string) {}

  private readAll(): Record<string, StoredToken> {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, StoredToken>;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw e;
    }
  }

  private writeAll(all: Record<string, StoredToken>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  get(apiId: string): StoredToken | undefined {
    return this.readAll()[apiId];
  }

  put(apiId: string, t: StoredToken): void {
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
