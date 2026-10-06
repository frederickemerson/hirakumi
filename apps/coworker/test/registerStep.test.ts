import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { registerStep, type MasumiPort, type RegisterDeps, type RegistryStatus } from "../src/onboarding/registerStep.js";
import { MasumiApiError, validateListing } from "@hirakumi/masumi";
import { finishStep, getStep } from "../src/steps.js";
import { createTestDb, messagesFor, seedApi, type TestDb } from "./helpers/db.js";

let db: TestDb;
beforeAll(async () => (db = await createTestDb()));
afterAll(async () => db.close());

const UNIT = "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d";

async function seedPublished(): Promise<string> {
  const apiId = await seedApi(db.pool, { state: "registering", sokosumiTaskId: "tsk_9" });
  await db.pool.query(`insert into packs (id, api_id, calls, price_micros, escrow_price_micros) values ($1, $2, 100, 2000000, 1500000)`, [`pk_${apiId}`, apiId]);
  await finishStep(db.pool, apiId, "qa", { listing: { summary: "s", description: "Live crypto prices.", tags: ["crypto"] }, exampleOutput: '{"price":1}' });
  return apiId;
}

function deps(masumi: MasumiPort, offsetMs = 0): RegisterDeps {
  return {
    pool: db.pool,
    masumi,
    masumiConfig: { baseUrl: "http://payment-service:3001/api/v1", token: "t", network: "Preprod", registryToken: "rt" },
    publicBaseUrl: "https://api.hirakumi.app",
    webBaseUrl: "https://web.test",
    escrowUnit: UNIT,
    now: () => new Date(Date.now() + offsetMs),
  };
}

const fakeMasumi = (status: RegistryStatus = "Online") => ({
  // Runs the payment service's real listing rules, so a listing the node would reject fails here too.
  registerAgent: vi.fn(async (_c: unknown, a: Parameters<typeof validateListing>[0]) => {
    validateListing(a);
    return { registrationId: "reg_1" };
  }),
  getAgentIdentifier: vi.fn().mockResolvedValue("agent_abc"),
  getRegistryStatus: vi.fn().mockResolvedValue(status),
});

describe("registerStep (registering → live)", () => {
  it("never mints twice: if recording a successful registration fails, the step stops instead of retrying (audit I2)", async () => {
    const apiId = await seedPublished();
    // Make the write of the registration id fail for this API only, as a DB blip would.
    await db.pool.query(`
      create or replace function fail_register_save() returns trigger language plpgsql as $$
      begin
        if new.api_id = '${apiId}' and new.step = 'register' and new.output ? 'registrationId' then
          raise exception 'connection reset';
        end if;
        return new;
      end $$;
      create trigger fail_register_save before update on onboard_steps for each row execute function fail_register_save();`);
    try {
      const masumi = fakeMasumi();
      await registerStep(deps(masumi), apiId);
      await registerStep(deps(masumi, 120_000), apiId);
      await registerStep(deps(masumi, 600_000), apiId);
      expect(masumi.registerAgent).toHaveBeenCalledTimes(1);
      const step = await getStep(db.pool, apiId, "register");
      expect(step?.status).toBe("failed");
      expect(JSON.stringify(step?.output)).toContain("reg_1");
    } finally {
      await db.pool.query(`drop trigger fail_register_save on onboard_steps; drop function fail_register_save();`);
    }
  });

  it("registers once with the wrapper URL and escrow price, then goes Live when the registry says Online", async () => {
    const apiId = await seedPublished();
    const masumi = fakeMasumi();
    await registerStep(deps(masumi), apiId);
    expect(masumi.registerAgent).toHaveBeenCalledTimes(1);
    expect(masumi.registerAgent.mock.calls[0][1]).toEqual({
      name: "Price API",
      description: "Live crypto prices.",
      apiBaseUrl: `https://api.hirakumi.app/a/${apiId}`,
      priceMicros: 1500000n,
      unit: UNIT,
      tags: ["crypto"],
    });
    await registerStep(deps(masumi, 60_000), apiId);
    expect(masumi.registerAgent).toHaveBeenCalledTimes(1);
    const { rows: [api] } = await db.pool.query(`select state, agent_identifier from apis where id = $1`, [apiId]);
    expect(api).toEqual({ state: "live", agent_identifier: "agent_abc" });
    const msgs = await messagesFor(db.pool, apiId);
    expect(msgs.map((m) => m.task_status)).toEqual(["RUNNING", "COMPLETED"]);
    expect(msgs[1].body).toMatch(/Agent ID: agent_abc/);
  });

  it("builds a listing the registry accepts from real QA output (long text, no tags, JSON example)", async () => {
    const apiId = await seedApi(db.pool, { state: "registering" });
    await db.pool.query(`insert into packs (id, api_id, calls, price_micros, escrow_price_micros) values ($1, $2, 100, 2000000, 1500000)`, [`pk_${apiId}`, apiId]);
    await finishStep(db.pool, apiId, "qa", { listing: { summary: "s", description: "x".repeat(600), tags: [] }, exampleOutput: '{"usd":0.27}' });
    const masumi = fakeMasumi();
    await registerStep(deps(masumi), apiId);
    expect(masumi.registerAgent).toHaveBeenCalledTimes(1);
    const sent = masumi.registerAgent.mock.calls[0][1];
    expect(sent.description.length).toBeLessThanOrEqual(250);
    expect(sent.tags.length).toBeGreaterThan(0);
    expect(sent).not.toHaveProperty("exampleOutput");
    expect((await getStep(db.pool, apiId, "register"))?.output?.registrationId).toBe("reg_1");
  });

  it("goes Live once the agent NFT is minted when no registry token is configured (status check skipped)", async () => {
    const apiId = await seedPublished();
    const masumi = fakeMasumi("Offline");
    const noToken = { ...deps(masumi), masumiConfig: { baseUrl: "http://payment-service:3001/api/v1", token: "t", network: "Preprod" as const } };
    await registerStep(noToken, apiId);
    await registerStep({ ...noToken, now: () => new Date(Date.now() + 60_000) }, apiId);
    expect(masumi.getRegistryStatus).not.toHaveBeenCalled();
    const { rows: [api] } = await db.pool.query(`select state from apis where id = $1`, [apiId]);
    expect(api.state).toBe("live");
  });

  it("does not retry registerAgent after an ambiguous failure such as a timeout (no double mint)", async () => {
    const apiId = await seedPublished();
    const masumi = fakeMasumi();
    masumi.registerAgent.mockRejectedValueOnce(new MasumiApiError(0, "/registry", "request timed out"));
    await registerStep(deps(masumi), apiId);
    await registerStep(deps(masumi, 3_600_000), apiId);
    expect(masumi.registerAgent).toHaveBeenCalledTimes(1);
    expect((await getStep(db.pool, apiId, "register"))?.status).toBe("failed");
  });

  it("never calls registerAgent again after an interrupted attempt (no double mint)", async () => {
    const apiId = await seedPublished();
    await db.pool.query(`insert into onboard_steps (api_id, step, status, attempts) values ($1, 'register', 'running', 1)`, [apiId]);
    const masumi = fakeMasumi();
    await registerStep(deps(masumi), apiId);
    await registerStep(deps(masumi, 3_600_000), apiId);
    expect(masumi.registerAgent).not.toHaveBeenCalled();
    expect((await getStep(db.pool, apiId, "register"))?.status).toBe("failed");
    expect((await messagesFor(db.pool, apiId)).at(-1)?.body).toMatch(/interrupted.*never charged twice/);
  });

  it("stays registering while the registry is not Online yet", async () => {
    const apiId = await seedPublished();
    const masumi = fakeMasumi("Offline");
    await registerStep(deps(masumi), apiId);
    await registerStep(deps(masumi, 60_000), apiId);
    expect((await db.pool.query(`select state from apis where id = $1`, [apiId])).rows[0].state).toBe("registering");
  });
});
