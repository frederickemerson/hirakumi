import { getSql } from "@/lib/db";
import { errorJson } from "@/lib/http";
import { takeAskSlot } from "@/lib/ask/rate-limit";

export const LINK_LIMIT = 10;

/** Linking and unlinking a Sokosumi account: a few tries per seller per window, counted in Postgres like Ask Hirakumi. */
export async function linkRateLimited(sellerId: string): Promise<Response | null> {
  if (await takeAskSlot(getSql(), `sokosumi:seller:${sellerId}`, LINK_LIMIT)) return null;
  return errorJson(429, "Too many tries. Wait a few minutes and try again.");
}
