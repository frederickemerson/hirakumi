import type { TaskStatus } from "../messages.js";

/** Shapes verified against https://api.preprod.sokosumi.com/v1/openapi.json (fields we use only). */
export type SokosumiActor = { type: "user" | "coworker" | "sokoBot" | string; id: string };
export type SokosumiEvent = { id: string; taskId: string; createdAt: string; status?: string | null; comment?: string | null; actor?: SokosumiActor | null };
export type SokosumiTask = { id: string; name: string; userId: string; organizationId: string | null; status: string };
export type SokosumiCoworker = { id: string; name: string; isWhitelisted: boolean; capabilities: string[]; archivedAt: string | null };
export type TaskEventBody = { status?: TaskStatus; comment: string };
export type UsageInput = { userId: string; organizationId: string | null; idempotencyKey: string; credits: number; referenceId?: string };

export type SokosumiClient = {
  me(): Promise<SokosumiCoworker>;
  listEvents(p: { limit: number; cursor?: string }): Promise<{ events: SokosumiEvent[]; nextCursor: string | null }>;
  getTask(taskId: string): Promise<SokosumiTask>;
  createTaskEvent(taskId: string, body: TaskEventBody): Promise<{ id: string }>;
  reportUsage(u: UsageInput): Promise<{ id: string }>;
};

export class SokosumiHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "SokosumiHttpError";
  }
}

export function createSokosumiClient(o: { apiUrl: string; apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number }): SokosumiClient {
  const fetchImpl = o.fetchImpl ?? fetch;
  const base = `${o.apiUrl.replace(/\/+$/, "")}/v1`;

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<{ data: T; meta?: { pagination?: { nextCursor?: string | null } } }> {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${o.apiKey}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { message?: unknown };
        if (typeof j.message === "string") message = j.message;
      } catch {
        // keep raw text
      }
      throw new SokosumiHttpError(`Sokosumi ${method} ${path} returned ${res.status}: ${message}`, res.status);
    }
    const json = JSON.parse(text) as { data?: T; meta?: { pagination?: { nextCursor?: string | null } } };
    if (!json || typeof json !== "object" || !("data" in json)) throw new Error(`Sokosumi ${method} ${path}: response has no data envelope`);
    return json as { data: T; meta?: { pagination?: { nextCursor?: string | null } } };
  }

  return {
    async me() {
      return (await call<SokosumiCoworker>("GET", "/coworkers/me")).data;
    },
    async listEvents({ limit, cursor }) {
      const q = new URLSearchParams({ limit: String(limit) });
      if (cursor) q.set("cursor", cursor);
      const r = await call<SokosumiEvent[]>("GET", `/coworkers/me/events?${q}`);
      return { events: Array.isArray(r.data) ? r.data : [], nextCursor: r.meta?.pagination?.nextCursor ?? null };
    },
    async getTask(taskId) {
      return (await call<SokosumiTask>("GET", `/tasks/${encodeURIComponent(taskId)}`)).data;
    },
    async createTaskEvent(taskId, body) {
      return (await call<{ id: string }>("POST", `/tasks/${encodeURIComponent(taskId)}/events`, { ...body, channel: "SOKOSUMI" })).data;
    },
    async reportUsage(u) {
      return (await call<{ id: string }>("POST", "/coworkers/me/usage", u)).data;
    },
  };
}
