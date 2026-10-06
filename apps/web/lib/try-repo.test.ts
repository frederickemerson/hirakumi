import { beforeEach, describe, expect, it } from "vitest";
import { getSql } from "@/lib/db";
import { resetDb } from "@/test/db";
import { seedApi, seedOperation, seedSeller } from "@/test/factories";
import { listTryOperations } from "./try-repo";

describe("listTryOperations", () => {
  beforeEach(resetDb);

  it("lists only enabled endpoints of a live API, with their input schema", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "live");
    const on = await seedOperation(api.id, { opId: "getPrice", enabled: true });
    await seedOperation(api.id, { opId: "hidden", path: "/hidden", enabled: false });
    await getSql()`update operations set input_schema = ${getSql().json({ type: "object", required: ["symbol"] })} where id = ${on.id}`;
    const ops = await listTryOperations(getSql(), api.id);
    expect(ops).toEqual([expect.objectContaining({ opId: "getPrice", method: "GET", inputSchema: { type: "object", required: ["symbol"] } })]);
  });

  it("is empty for an API that is not live", async () => {
    const seller = await seedSeller();
    const api = await seedApi(seller.id, "intake");
    await seedOperation(api.id, { enabled: true });
    expect(await listTryOperations(getSql(), api.id)).toEqual([]);
  });
});
