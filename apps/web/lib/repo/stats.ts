import type { Sql } from "../db";

export type PackSale = {
  id: string;
  createdAt: Date;
  payer: string | null;
  calls: number;
  priceMicros: string;
  status: "pending" | "active" | "exhausted" | "revoked";
  remaining: number;
  txHash: string | null;
};

export type EscrowJob = {
  id: string;
  createdAt: Date;
  status: "awaiting_payment" | "running" | "completed" | "failed" | "expired";
  identifierFromPurchaser: string;
  blockchainIdentifier: string | null;
  failureReasons: unknown;
};

export async function listPackSales(sql: Sql, apiId: string, limit = 100): Promise<PackSale[]> {
  return sql<PackSale[]>`
    select t.id, t.created_at, t.payer, p.calls, p.price_micros::text as price_micros, t.status, t.remaining, t.tx_hash
    from credit_tokens t join packs p on p.id = t.pack_id
    where t.api_id = ${apiId}
    order by t.created_at desc limit ${limit}`;
}

export async function listEscrowJobs(sql: Sql, apiId: string, limit = 100): Promise<EscrowJob[]> {
  return sql<EscrowJob[]>`
    select id, created_at, status, identifier_from_purchaser, blockchain_identifier, failure_reasons
    from jobs where api_id = ${apiId}
    order by created_at desc limit ${limit}`;
}
