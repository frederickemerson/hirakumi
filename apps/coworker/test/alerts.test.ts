import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPERATOR_KEYS_UNAVAILABLE } from "@hirakumi/core";
import { processHealthEvents } from "../src/alerts.js";
import { createTestDb, messagesFor, seedApi, type TestDb } from "./helpers/db.js";

let db: TestDb;
beforeAll(async () => (db = await createTestDb()));
afterAll(async () => db.close());

async function probe(apiId: string, id: string, verdict: string, at: string) {
  await db.pool.query(
    `insert into calls (id, kind, api_id, op_id, execution, verdict, created_at) values ($1, 'probe', $2, 'getPrice', 'upstream_ok', $3, $4)`,
    [id, apiId, verdict, at],
  );
}

describe("processHealthEvents", () => {
  it("names the failing field and the first failure time, exactly once", async () => {
    const apiId = await seedApi(db.pool, { state: "live", sokosumiTaskId: "tsk_h" });
    await probe(apiId, `c1_${apiId}`, "pass", "2026-10-07T10:00:00Z");
    await probe(apiId, `c2_${apiId}`, "fail", "2026-10-07T10:00:10Z");
    await probe(apiId, `c3_${apiId}`, "fail", "2026-10-07T10:00:20Z");
    await db.pool.query(
      `insert into health_events (api_id, from_health, to_health, reasons, at) values ($1, 'healthy', 'down', $2::jsonb, '2026-10-07T10:00:20Z')`,
      [apiId, JSON.stringify([{ op: "getPrice", reason: "/price must be number", since: "2026-10-07T10:00:10Z" }])], // contract D5 shape
    );
    expect(await processHealthEvents(db.pool, "https://web.test")).toBe(1);
    expect(await processHealthEvents(db.pool, "https://web.test")).toBe(0);
    const msgs = await messagesFor(db.pool, apiId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].task_id).toBe("tsk_h");
    expect(msgs[0].body).toContain("Failing check: getPrice: /price must be number. First failed test: 2026-10-07 10:00:10 UTC.");
  });

  it("a rate-limited probe (inconclusive) is never the first failed test (audit 3)", async () => {
    const apiId = await seedApi(db.pool, { state: "live" });
    await probe(apiId, `r1_${apiId}`, "n/a", "2026-10-07T10:00:05Z");
    await probe(apiId, `f1_${apiId}`, "fail", "2026-10-07T10:00:10Z");
    await db.pool.query(
      `insert into health_events (api_id, from_health, to_health, reasons, at) values ($1, 'healthy', 'down', $2::jsonb, '2026-10-07T10:00:20Z')`,
      [apiId, JSON.stringify([{ op: "getPrice", reason: "/price must be number" }])],
    );
    await processHealthEvents(db.pool, "https://web.test");
    expect((await messagesFor(db.pool, apiId))[0].body).toContain("First failed test: 2026-10-07 10:00:10 UTC.");
  });

  it("announces recovery", async () => {
    const apiId = await seedApi(db.pool, { state: "live" });
    await db.pool.query(`insert into health_events (api_id, from_health, to_health, at) values ($1, 'down', 'healthy', '2026-10-07T10:05:00Z')`, [apiId]);
    await processHealthEvents(db.pool, "https://web.test");
    expect((await messagesFor(db.pool, apiId))[0].body).toMatch(/is Live again \(recovered at 2026-10-07 10:05:00 UTC\)/);
  });

  describe("operator-only key problems", () => {
    const operator = [{ op: "*", reason: OPERATOR_KEYS_UNAVAILABLE }];
    const seller = [{ op: "getPrice", reason: "/price must be number" }];

    async function event(apiId: string, to: "down" | "healthy", reasons: unknown[] = []) {
      await db.pool.query(
        `insert into health_events (api_id, from_health, to_health, reasons) values ($1, $2, $3, $4::jsonb)`,
        [apiId, to === "down" ? "healthy" : "down", to, JSON.stringify(reasons)],
      );
    }
    const unnotified = async (apiId: string) =>
      (await db.pool.query(`select id from health_events where api_id = $1 and notified_at is null`, [apiId])).rowCount;

    it("marks an operator-only Down and the Live after it notified without messaging the seller", async () => {
      const apiId = await seedApi(db.pool, { state: "live" });
      await event(apiId, "down", operator);
      await processHealthEvents(db.pool, "https://web.test");
      expect(await unnotified(apiId)).toBe(0);
      await event(apiId, "healthy");
      await processHealthEvents(db.pool, "https://web.test");
      expect(await unnotified(apiId)).toBe(0);
      expect(await messagesFor(db.pool, apiId)).toHaveLength(0);
    });

    it("still messages a Down that mixes our reason with the seller's, and its recovery", async () => {
      const apiId = await seedApi(db.pool, { state: "live" });
      await event(apiId, "down", [...operator, ...seller]);
      await event(apiId, "healthy");
      await processHealthEvents(db.pool, "https://web.test");
      const msgs = await messagesFor(db.pool, apiId);
      expect(msgs).toHaveLength(2);
      expect(msgs[0].body).toContain("is Down");
      expect(msgs[1].body).toContain("is Live again");
    });

    it("messages a seller Down that follows an operator-only one", async () => {
      const apiId = await seedApi(db.pool, { state: "live" });
      await event(apiId, "down", operator);
      await event(apiId, "healthy");
      await event(apiId, "down", seller);
      await event(apiId, "healthy");
      await processHealthEvents(db.pool, "https://web.test");
      const msgs = await messagesFor(db.pool, apiId);
      expect(msgs.map((m) => m.body.includes("is Down"))).toEqual([true, false]);
      expect(msgs[0].body).toContain("/price must be number");
    });

    describe("our keys come back while the API stays Down for the seller's reason", () => {
      const refused = "The API refused its key (HTTP 401). The seller should check or replace the key.";

      async function operatorDown(apiId: string, at: string) {
        await db.pool.query(`update apis set health = 'down' where id = $1`, [apiId]);
        await db.pool.query(
          `insert into health_events (api_id, from_health, to_health, reasons, at) values ($1, 'healthy', 'down', $2::jsonb, $3)`,
          [apiId, JSON.stringify(operator), at],
        );
      }
      async function failedProbe(apiId: string, id: string, at: string) {
        await db.pool.query(
          `insert into calls (id, kind, api_id, op_id, execution, verdict, verdict_reasons, created_at)
           values ($1, 'probe', $2, 'getPrice', 'upstream_error', 'n/a', $3::jsonb, $4)`,
          [id, apiId, JSON.stringify([refused]), at],
        );
      }

      async function reblamed(apiId: string, at: string) {
        // apps/gateway health.ts: failsToDown seller-reason rounds after an operator-only Down give a down to down event.
        await db.pool.query(
          `insert into health_events (api_id, from_health, to_health, reasons, at) values ($1, 'down', 'down', $2::jsonb, $3)`,
          [apiId, JSON.stringify([{ op: "getPrice", reason: refused }]), at],
        );
      }

      it("tells the seller once the gateway re-blames the Down, quoting the new reason, and then announces the Live", async () => {
        const apiId = await seedApi(db.pool, { state: "live" });
        await operatorDown(apiId, "2026-10-07T11:00:00Z");
        await processHealthEvents(db.pool, "https://web.test");
        expect(await messagesFor(db.pool, apiId)).toHaveLength(0);

        await failedProbe(apiId, `k1_${apiId}`, "2026-10-07T11:10:00Z");
        await failedProbe(apiId, `k2_${apiId}`, "2026-10-07T11:12:00Z");
        await failedProbe(apiId, `k3_${apiId}`, "2026-10-07T11:14:00Z");
        await reblamed(apiId, "2026-10-07T11:14:00Z");
        await processHealthEvents(db.pool, "https://web.test");
        await processHealthEvents(db.pool, "https://web.test");
        let msgs = await messagesFor(db.pool, apiId);
        expect(msgs).toHaveLength(1);
        expect(msgs[0].body).toContain(`is Down. Failing check: getPrice: ${refused}. First failed test: 2026-10-07 11:10:00 UTC.`);

        await db.pool.query(`update apis set health = 'healthy' where id = $1`, [apiId]);
        await event(apiId, "healthy");
        await processHealthEvents(db.pool, "https://web.test");
        msgs = await messagesFor(db.pool, apiId);
        expect(msgs).toHaveLength(2);
        expect(msgs[1].body).toContain("is Live again");
      });

      it("never messages from probe rows alone: one failing or rate-limited probe after an operator-only Down stays quiet (audit 3)", async () => {
        const apiId = await seedApi(db.pool, { state: "live" });
        await operatorDown(apiId, "2026-10-07T11:00:00Z");
        await processHealthEvents(db.pool, "https://web.test");
        await failedProbe(apiId, `k1_${apiId}`, "2026-10-07T11:10:00Z");
        await probe(apiId, `r1_${apiId}`, "n/a", "2026-10-07T11:12:00Z"); // a 429, stored as inconclusive
        await processHealthEvents(db.pool, "https://web.test");
        expect(await messagesFor(db.pool, apiId)).toHaveLength(0);
        // The Live after it stays quiet too: the seller never heard of the Down.
        await event(apiId, "healthy");
        await processHealthEvents(db.pool, "https://web.test");
        expect(await messagesFor(db.pool, apiId)).toHaveLength(0);
      });
    });
  });
});
