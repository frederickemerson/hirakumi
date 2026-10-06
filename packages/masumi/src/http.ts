import { MasumiApiError } from "./errors.js";

export type Query = Record<string, string | number | undefined>;

type Envelope = { status?: string; data?: unknown; error?: { message?: string } };

/** One call to a Masumi service: `token` header, `{status:"success",data}` envelope, token-redacted errors. */
export async function call<T>(
  baseUrl: string,
  token: string,
  method: "GET" | "POST",
  path: string,
  opts: { query?: Query; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const url = new URL(baseUrl.replace(/\/+$/, "") + path);
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = { token, accept: "application/json" };
  if (opts.body !== undefined) headers["content-type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
  } catch (error) {
    throw new MasumiApiError(0, path, `request failed: ${(error as Error).message}`);
  }

  const text = await response.text();
  let envelope: Envelope | undefined;
  try {
    envelope = text ? (JSON.parse(text) as Envelope) : undefined;
  } catch {
    envelope = undefined;
  }
  if (!response.ok || envelope?.status !== "success") {
    const raw = (envelope?.error?.message ?? text.slice(0, 300)) || response.statusText || "empty response";
    const detail = token ? raw.split(token).join("***") : raw;
    throw new MasumiApiError(response.status, path, detail);
  }
  return envelope.data as T;
}
