import type { Sql } from "../db";

export type ChatMessage = { id: string; apiId: string | null; author: "seller" | "coworker"; body: string; createdAt: Date };

export async function listChat(sql: Sql, sellerId: string, apiId: string | null, afterId: number): Promise<ChatMessage[]> {
  return sql<ChatMessage[]>`
    select id::text as id, api_id, author, body, created_at from messages
    where ${apiId === null
      ? sql`api_id is null and seller_id = ${sellerId}`
      // An API's thread belongs to whoever owns the API (the coworker's rows carry api_id, not seller_id).
      : sql`api_id = ${apiId} and exists (select 1 from apis a where a.id = ${apiId} and a.seller_id = ${sellerId})`}
      and id > ${afterId}
    order by id asc limit 200`;
}

export async function postSellerMessage(sql: Sql, sellerId: string, apiId: string | null, body: string): Promise<ChatMessage> {
  const [row] = await sql<ChatMessage[]>`
    insert into messages (seller_id, api_id, author, body) values (${sellerId}, ${apiId}, 'seller', ${body})
    returning id::text as id, api_id, author, body, created_at`;
  return row;
}
