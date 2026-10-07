import { ACT_PLACEHOLDER_RE, ACT_PLACEHOLDER_TEXT } from "@hirakumi/core";
import type { Sql } from "../db";

export type ChatMessage = { id: string; apiId: string | null; author: "seller" | "coworker"; body: string; createdAt: Date };

/**
 * A Sokosumi task's message names its one-time signing link as a placeholder (the outbox makes the link when it
 * posts the comment), so the log here says where the link is instead.
 */
export async function listChat(sql: Sql, sellerId: string, apiId: string | null, afterId: number): Promise<ChatMessage[]> {
  const rows = await sql<ChatMessage[]>`
    select id::text as id, api_id, author, body, created_at from messages
    where ${apiId === null
      ? sql`api_id is null and seller_id = ${sellerId}`
      // An API's thread belongs to whoever owns the API (the coworker's rows carry api_id, not seller_id).
      : sql`api_id = ${apiId} and exists (select 1 from apis a where a.id = ${apiId} and a.seller_id = ${sellerId})`}
      and id > ${afterId}
    order by id asc limit 200`;
  return rows.map((m) => ({ ...m, body: m.body.replace(ACT_PLACEHOLDER_RE, ACT_PLACEHOLDER_TEXT) }));
}

export async function postSellerMessage(sql: Sql, sellerId: string, apiId: string | null, body: string): Promise<ChatMessage> {
  const [row] = await sql<ChatMessage[]>`
    insert into messages (seller_id, api_id, author, body) values (${sellerId}, ${apiId}, 'seller', ${body})
    returning id::text as id, api_id, author, body, created_at`;
  return row;
}
