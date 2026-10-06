import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSql } from "@/lib/db";
import { resetDb } from "@/test/db";
import { seedApi, seedSeller } from "@/test/factories";
import { cookieFor, jsonRequest } from "@/test/requests";
import { GET, POST } from "./route";

describe("/api/chat", () => {
  beforeEach(resetDb);
  afterEach(() => {
    process.env.CHAT_FALLBACK = "1";
  });

  it("stores the seller's message and lists the thread after a cursor", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id);
    const cookie = cookieFor(seller);
    const posted = await POST(jsonRequest("/api/chat", { cookie, body: { apiId: api.id, body: "  Is my file right?  " } }));
    expect(posted.status).toBe(201);
    const { message } = (await posted.json()) as { message: { id: string; body: string; author: string } };
    expect(message).toMatchObject({ body: "Is my file right?", author: "seller" });
    await getSql()`
      insert into messages (seller_id, api_id, author, body) values (${seller.id}, ${api.id}, 'coworker', 'Yes, it matches.')`;
    const res = await GET(jsonRequest(`/api/chat?apiId=${api.id}&after=${message.id}`, { cookie }));
    const { messages } = (await res.json()) as { messages: { author: string; body: string }[] };
    expect(messages).toEqual([expect.objectContaining({ author: "coworker", body: "Yes, it matches." })]);
  });

  it("keeps threads per API", async () => {
    const seller = await seedSeller();
    const a = await seedApi(seller.id, "intake", { openapiUrl: "https://a.example/openapi.json" });
    const b = await seedApi(seller.id, "intake", { openapiUrl: "https://b.example/openapi.json" });
    const cookie = cookieFor(seller);
    await POST(jsonRequest("/api/chat", { cookie, body: { apiId: a.id, body: "about A" } }));
    const res = await GET(jsonRequest(`/api/chat?apiId=${b.id}&after=0`, { cookie }));
    expect(((await res.json()) as { messages: unknown[] }).messages).toEqual([]);
  });

  it("returns 404 for another seller's API", async () => {
    const owner = await seedSeller();
    const api = await seedApi(owner.id);
    const intruder = await seedSeller();
    const res = await POST(jsonRequest("/api/chat", { cookie: cookieFor(intruder), body: { apiId: api.id, body: "hi" } }));
    expect(res.status).toBe(404);
  });

  it("refuses an empty message", async () => {
    const seller = await seedSeller();
    const res = await POST(jsonRequest("/api/chat", { cookie: cookieFor(seller), body: { apiId: null, body: "   " } }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Write a message first." });
  });

  it("is off unless CHAT_FALLBACK=1", async () => {
    process.env.CHAT_FALLBACK = "0";
    const seller = await seedSeller();
    const res = await GET(jsonRequest("/api/chat?after=0", { cookie: cookieFor(seller) }));
    expect(res.status).toBe(404);
  });
});
