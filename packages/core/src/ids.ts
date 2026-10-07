import { createHash, randomBytes } from "node:crypto";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
export type IdPrefix = "sel" | "api" | "op" | "pk" | "ct" | "call" | "job" | "rule" | "ch" | "ti" | "try" | "act";

export function newId(prefix: IdPrefix): string {
  let out = "";
  for (const b of randomBytes(10)) out += BASE32[b & 31];
  return `${prefix}_${out}`;
}

export function newBearerToken(): string {
  return `hk_${randomBytes(32).toString("base64url")}`;
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
