import { verifyRecordFor } from "@hirakumi/core";
import { STATE_LABEL } from "../copy";
import type { Sql } from "../db";
import { listApisForSeller } from "../repo/apis";
import { findVerifyCode } from "../repo/challenges";
import { loadProgress } from "../repo/progress";
import { hasDnsVerifySchema } from "../repo/schema";

/** Enough for any real seller; keeps the prompt small for one with many test listings. */
const MAX_APIS = 10;

/** Seller-controlled text (the API name comes from their OpenAPI file): one line, bounded, no quote breakouts. */
function clean(text: string, max: number): string {
  return text.replace(/[\u0000-\u001f\u007f"]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * The DNS record an API still has to get (it is on the ownership step), so the assistant can say exactly what to type.
 * The code is public once in DNS, and this summary only ever describes the signed-in seller's own APIs.
 */
async function dnsRecordLine(sql: Sql, api: { id: string; origin: string; state: string }): Promise<string | null> {
  if (api.state !== "endpoints_confirmed" || !(await hasDnsVerifySchema(sql))) return null;
  const record = verifyRecordFor(api.origin);
  const code = record.ok ? await findVerifyCode(sql, api.id) : null;
  return record.ok && code ? `DNS record to add: TXT, name ${record.name}, value ${code.code}` : null;
}

/**
 * A short summary of the signed-in seller's own APIs for the assistant: name, id, state, current step, and the DNS
 * record still to add while proving ownership.
 * Every query is scoped to `sellerId`, which comes from the verified session cookie, never from the request body.
 * Null when the seller has no APIs.
 */
export async function sellerSummary(sql: Sql, sellerId: string): Promise<string | null> {
  const apis = (await listApisForSeller(sql, sellerId)).slice(0, MAX_APIS);
  if (apis.length === 0) return null;
  const lines = await Promise.all(
    apis.map(async (api) => {
      const progress = await loadProgress(sql, api);
      const parts = [`"${clean(api.name, 80)}" (${api.id})`, `state: ${STATE_LABEL[api.state]}`];
      if (api.state === "live") parts.push(`health: ${api.health === "healthy" ? "Live" : "Down"}`);
      else if (progress.timeline.current) parts.push(`current step: ${progress.timeline.current.label}`);
      if (progress.failure) parts.push(`problem: ${clean(progress.failure, 160)}`);
      const dns = await dnsRecordLine(sql, api);
      if (dns) parts.push(dns);
      parts.push(`page: ${progress.href}`);
      return `- ${parts.join("; ")}`;
    }),
  );
  return lines.join("\n");
}
