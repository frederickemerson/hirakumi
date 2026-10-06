/** Thrown with a message that is safe to show the seller verbatim. */
export class RequestError extends Error {}

async function handle<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new RequestError(data.error ?? "Something went wrong. Try again.");
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

export async function getJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch {
    throw new RequestError("We couldn't reach Hirakumi. Check your connection and try again.");
  }
  return handle<T>(res);
}
