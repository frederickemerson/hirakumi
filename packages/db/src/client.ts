import postgres from "postgres";

export type Sql = postgres.Sql;

/** One pooled postgres.js client. `searchPath` pins every connection to one schema (tests use this). */
export function createDb(url: string, opts: { searchPath?: string; max?: number } = {}): Sql {
  return postgres(url, {
    max: opts.max ?? 10,
    onnotice: () => undefined,
    ...(opts.searchPath
      ? { connection: { search_path: opts.searchPath } as unknown as postgres.Options<{}>["connection"] }
      : {}),
  });
}
