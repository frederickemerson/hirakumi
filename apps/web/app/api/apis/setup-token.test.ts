import { beforeEach, describe, expect, it } from "vitest";
import { getSql } from "@/lib/db";
import { resetDb } from "@/test/db";
import { seedSeller } from "@/test/factories";
import { cookieFor, jsonRequest } from "@/test/requests";
import { POST } from "./route";

// Review I5: the coworker's setup link (/setup?t=<setup_token>) must tie the new API to the Sokosumi task,
// so onboarding progress, Down alerts and the completion comment reach that task and usage is billed.
async function seedTask(token: string) {
  await getSql()`insert into coworker_tasks (task_id, sokosumi_user_id, task_name, setup_token)
                 values (${"tsk_" + token}, 'usr_soko_1', 'Put my API on the agent market', ${token})`;
}
const create = (cookie: string, body: Record<string, unknown>) =>
  POST(jsonRequest("/api/apis", { cookie, body: { openapiUrl: "https://price.example.dev/openapi.json", name: "Price API", ...body } }));

describe("POST /api/apis with a Sokosumi setup token", () => {
  beforeEach(resetDb);

  it("links the new API to the Sokosumi task and the seller to the Sokosumi user", async () => {
    const seller = await seedSeller();
    await seedTask("tok_a");
    const res = await create(cookieFor(seller), { setupToken: "tok_a" });
    expect(res.status).toBe(201);
    const { apiId } = (await res.json()) as { apiId: string };
    const [api] = await getSql()<{ sokosumiTaskId: string | null }[]>`select sokosumi_task_id from apis where id = ${apiId}`;
    expect(api.sokosumiTaskId).toBe("tsk_tok_a");
    const [s] = await getSql()<{ sokosumiUserId: string | null }[]>`select sokosumi_user_id from sellers where id = ${seller.id}`;
    expect(s.sokosumiUserId).toBe("usr_soko_1");
  });

  it("using the same setup link again returns the same API", async () => {
    const seller = await seedSeller();
    await seedTask("tok_b");
    const first = (await (await create(cookieFor(seller), { setupToken: "tok_b" })).json()) as { apiId: string };
    const again = await create(cookieFor(seller), { setupToken: "tok_b", openapiUrl: "https://price.example.dev/v2/openapi.json" });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { apiId: string }).apiId).toBe(first.apiId);
  });

  it("rejects an unknown setup link with a plain message", async () => {
    const seller = await seedSeller();
    const res = await create(cookieFor(seller), { setupToken: "nope" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/setup link/i);
  });

  it("works exactly as before without a setup token", async () => {
    const seller = await seedSeller();
    const res = await create(cookieFor(seller), {});
    expect(res.status).toBe(201);
  });
});
