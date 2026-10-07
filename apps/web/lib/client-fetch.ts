/** Thrown with a message that is safe to show the seller verbatim. */
export class RequestError extends Error {
  /** The HTTP status, when the server answered; `code` names a known refusal (such as KEY_REFUSED). */
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
  }
}

async function handle<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; code?: unknown };
  if (!res.ok) {
    throw new RequestError(data.error ?? "Something went wrong. Try again.", res.status, typeof data.code === "string" ? data.code : undefined);
  }
  return data;
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new RequestError("We couldn't reach Hirakumi. Check your connection and try again.");
  }
  return handle<T>(res);
}

export async function deleteJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { method: "DELETE", headers: { accept: "application/json" } });
  } catch {
    throw new RequestError("We couldn't reach Hirakumi. Check your connection and try again.");
  }
  return handle<T>(res);
}
