import pg from "pg";

export type Db = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string, searchPath?: string): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: 5,
    ...(searchPath ? { options: `-c search_path=${searchPath}` } : {}),
  });
}

export async function withTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}
