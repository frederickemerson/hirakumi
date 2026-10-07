import { getSql } from "@/lib/db";

// Every table hangs off sellers through foreign keys, so one cascade empties them all (messages included). Used
// sign-in nonces (0017) belong to no seller and are emptied with them.
export async function resetDb(): Promise<void> {
  await getSql()`truncate sellers, used_login_nonces restart identity cascade`;
}
