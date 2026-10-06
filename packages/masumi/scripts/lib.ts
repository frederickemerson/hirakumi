import { createHash } from "node:crypto";

export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** MIP-004: sha256(identifier_from_purchaser + ";" + payload). payload = JCS(input) for input hashes, raw output for results. */
export const mip004 = (identifier: string, payload: string): string => sha256Hex(`${identifier};${payload}`);

/** RFC 8785 for a flat object of strings: sorted keys, JSON string escaping (sufficient for the E2E inputs). */
export function jcsFlat(obj: Record<string, string>): string {
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${JSON.stringify(obj[key])}`)
    .join(",")}}`;
}

export function intervalSeconds(isoTimes: string[]): { count: number; min: number; median: number; max: number } | null {
  const times = [...new Set(isoTimes)].map((t) => Date.parse(t)).sort((a, b) => a - b);
  if (times.length < 2) return null;
  const gaps = times.slice(1).map((t, i) => (t - times[i]) / 1000).sort((a, b) => a - b);
  return { count: gaps.length, min: gaps[0], median: gaps[Math.floor(gaps.length / 2)], max: gaps[gaps.length - 1] };
}

export type StartJobTerms = {
  jobId: string;
  blockchainIdentifier: string;
  agentIdentifier: string;
  sellerVKey: string;
  inputHash: string;
  identifierFromPurchaser: string;
  payByTime: Date;
  submitResultTime: Date;
  unlockTime: Date;
  externalDisputeUnlockTime: Date;
};

/** Reads a MIP-003 start_job response (field names per contract delta 6). */
export function parseStartJob(body: Record<string, unknown>): StartJobTerms {
  const need = (key: string): unknown => {
    const value = body[key];
    if (value === undefined || value === null || value === "") throw new Error(`start_job response is missing ${key}`);
    return value;
  };
  const ms = (key: string): Date => {
    const n = Number(need(key));
    if (!Number.isFinite(n)) throw new Error(`start_job ${key} is not a unix-ms time`);
    return new Date(n);
  };
  return {
    jobId: String(need("job_id")),
    blockchainIdentifier: String(need("blockchainIdentifier")),
    agentIdentifier: String(need("agentIdentifier")),
    sellerVKey: String(need("sellerVKey")),
    inputHash: String(need("input_hash")),
    identifierFromPurchaser: String(need("identifierFromPurchaser")),
    payByTime: ms("payByTime"),
    submitResultTime: ms("submitResultTime"),
    unlockTime: ms("unlockTime"),
    externalDisputeUnlockTime: ms("externalDisputeUnlockTime"),
  };
}
