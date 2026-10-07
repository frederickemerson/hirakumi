import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { buildWalletChallenge } from "@hirakumi/core";
import { closeSql, getSql } from "../../web/lib/db";
import { createGateway } from "../../web/lib/gateway";
import {
  createWalletChallenge, finalizeOwnership, findVerifyCode, getOpenWalletChallenge, getOrCreateVerifyCode, hasFreshVerifyPass,
  markVerifyPassed,
} from "../../web/lib/repo/challenges";
import { makeHarness, type Harness } from "./helpers";

/**
 * The header proof across the two apps, each with its own code: the web app makes the API's code (kind 'header'),
 * its gateway client asks the real gateway over HTTP, the gateway reads that code from the same database and finds
 * it in the X-Hirakumi-Verify header at the base URL, and the web app records the pass and finalises ownership after
 * the wallet signature (verified by the web route with CIP-30; taken as valid here). The web functions run on the
 * web app's own connection (camelCase columns), pointed at the harness schema.
 */
const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://hirakumi:hirakumi@localhost:5432/hirakumi";

describe("ownership contract: web code, gateway header check, web finalise", () => {
  let h: Harness;
  let server: Server;
  afterEach(async () => {
    await closeSql();
    delete process.env.DATABASE_URL;
    await new Promise<void>((done) => server.close(() => done()));
    await h.close();
  });

  it("a code made by the web app, sent as a header at the base URL, ends in ownership_verified", async () => {
    h = await makeHarness();
    server = createServer(h.app);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const gateway = createGateway({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: h.config.internalToken });
    const url = new URL(TEST_URL);
    url.searchParams.set("search_path", h.db.schema);
    process.env.DATABASE_URL = url.href;
    const sql = getSql();
    const { apiId, sellerId, payTo } = h.seeded;
    await h.sql`update apis set state = 'endpoints_confirmed', path_prefix = '/v1' where id = ${apiId}`;

    // Web: the ownership page creates the code (spec-check route does the same before asking the gateway).
    const code = await getOrCreateVerifyCode(sql, apiId);
    const [row] = await h.sql<{ kind: string }[]>`select kind from challenges where id = ${code.id}`;
    expect(row.kind).toBe("header");

    // Not sent yet: the gateway answers "missing" and nothing is recorded.
    h.stub.setFile("/v1", "not found", { status: 404, contentType: "text/plain" });
    const before = await gateway.checkChallenge(apiId);
    expect(before).toMatchObject({ ok: false, reason: "missing", triedUrl: `${h.stub.origin}/v1`, status: 404 });

    // The seller's API sends the header, on a 404 page at the base URL.
    h.stub.setFile("/v1", "not found", { status: 404, contentType: "text/plain", headers: { "X-Hirakumi-Verify": code.code } });
    const result = await gateway.checkChallenge(apiId);
    expect(result).toMatchObject({ ok: true, reason: "verified", triedUrl: `${h.stub.origin}/v1`, status: 404 });
    expect(h.stub.fileHits("/v1")).toBe(2);
    await markVerifyPassed(sql, code.id, result.triedUrl);
    expect(await hasFreshVerifyPass(sql, apiId)).toBe(true);
    expect((await findVerifyCode(sql, apiId))?.passedAt).toBeTruthy();

    // Web: the wallet challenge, then finalise. The CIP-30 check itself is the verify route's (mocked here as passed).
    const nonce = "0123456789abcdef0123456789abcdef";
    const expiresAt = new Date(Date.now() + 30 * 60_000);
    const message = buildWalletChallenge({
      domain: "hirakumi.test", sellerId, apiId, origin: h.stub.origin, payTo, network: "cardano:preprod", nonce, expires: expiresAt.toISOString(),
    });
    const challengeId = await createWalletChallenge(sql, { apiId, nonce, expiresAt, message });
    const open = await getOpenWalletChallenge(sql, challengeId, apiId);
    expect(open?.message).toBe(message);
    const done = await finalizeOwnership(sql, { apiId, walletChallengeId: challengeId, signature: "a1b2", key: "c3d4" });
    expect(done).toEqual({ ok: true, warnings: [] });

    const [api] = await h.sql<{ state: string }[]>`select state from apis where id = ${apiId}`;
    expect(api.state).toBe("ownership_verified");
    // The code is used up: the gateway has no open code left to check.
    expect(await findVerifyCode(sql, apiId)).toBeNull();
    expect(await gateway.checkChallenge(apiId)).toMatchObject({ ok: false, reason: "no_code" });
  });
});
