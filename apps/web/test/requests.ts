import { createSessionToken } from "@/lib/session";
import type { Seller } from "@/lib/types";

export function jsonRequest(
  path: string,
  init: { method?: string; cookie?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = {};
  if (init.cookie) headers.cookie = init.cookie;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`https://web.hirakumi.test${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

export function ctx(apiId: string): { params: Promise<{ apiId: string }> } {
  return { params: Promise.resolve({ apiId }) };
}

export function cookieFor(seller: Seller): string {
  return `hk_session=${createSessionToken(seller.id, seller.cardanoAddr)}`;
}
