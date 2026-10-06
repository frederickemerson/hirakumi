import { newId } from "@hirakumi/core";
import type { Sql } from "../db";
import type { Seller } from "../types";

export async function upsertSeller(sql: Sql, cardanoAddr: string): Promise<Seller> {
  const [row] = await sql<Seller[]>`
    insert into sellers (id, cardano_addr) values (${newId("sel")}, ${cardanoAddr})
    on conflict (cardano_addr) do update set cardano_addr = excluded.cardano_addr
    returning id, cardano_addr`;
  return row;
}
