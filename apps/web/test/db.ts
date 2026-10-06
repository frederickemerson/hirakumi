import { getSql } from "@/lib/db";

// Every table hangs off sellers through foreign keys, so one cascade empties them all (messages included).
export async function resetDb(): Promise<void> {
  await getSql()`truncate sellers restart identity cascade`;
}
