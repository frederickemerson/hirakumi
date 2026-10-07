import { BlockList, isIP } from "node:net";
import { Router } from "express";
import { inputHash, newId } from "@hirakumi/core";
import { getJob, insertJob, type JobRow } from "@hirakumi/db";
import { estimatedDowntimeSeconds } from "./config";
import type { AppDeps } from "./deps";
import { downBody, SELLER_BODY_HEADERS, sellingPausedBody } from "./http";
import { escrowOperation } from "./registry";
import { normalizeMip003Input } from "./upstream";

export type Mip003Field = {
  id: string; type: "string" | "number" | "boolean" | "option"; name: string;
  data?: { description?: string; options?: string[] };
};

/** JSON Schema object properties → Sokosumi/MIP-003 typed input fields. */
export function toMip003Fields(schema: Record<string, unknown>): Mip003Field[] {
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  return Object.entries(props).map(([id, p]) => {
    const options = Array.isArray(p.enum) ? p.enum.map(String) : null;
    const type: Mip003Field["type"] = options
      ? "option"
      : p.type === "number" || p.type === "integer" ? "number"
      : p.type === "boolean" ? "boolean"
      : "string";
    const data: NonNullable<Mip003Field["data"]> = {};
    if (typeof p.description === "string") data.description = p.description;
    if (options) data.options = options;
    return { id, type, name: typeof p.title === "string" ? p.title : id, data };
  });
}

/** Must match what the Masumi node accepts (14-26 hex), or the payment request fails with a 500 (audit I3). */
export const PURCHASER_ID = /^(?:[0-9a-f]{2}){7,13}$/;

/** start_job creates a Masumi payment request and a job row, so unauthenticated floods are capped per client. */
const START_JOB_LIMIT = { max: 10, windowMs: 60_000 };
/**
 * Sokosumi's backend and payment nodes call from a few shared addresses, so one per-address limit would be shared by
 * every Sokosumi user. MIP-003 start_job carries nothing verifiable (no signature or key), so trust is by source range
 * (START_JOB_TRUSTED_CIDRS), still counted per address so one runaway caller can't take unlimited payment requests.
 */
export const START_JOB_TRUSTED_LIMIT = { max: 600, windowMs: 60_000 };

/** A predicate over client addresses for the given CIDRs. IPv4-mapped IPv6 (::ffff:a.b.c.d) is checked as IPv4. */
export function trustedAddressMatcher(cidrs: string[]): (ip: string | undefined) => boolean {
  if (cidrs.length === 0) return () => false;
  const list = new BlockList();
  for (const c of cidrs) {
    const [addr, prefix] = c.split("/");
    const family = isIP(addr) === 6 ? "ipv6" : "ipv4";
    list.addSubnet(addr, Number(prefix), family);
  }
  return (ip) => {
    if (!ip) return false;
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
    const addr = mapped ? mapped[1] : ip;
    const family = isIP(addr);
    if (family === 0) return false;
    return list.check(addr, family === 6 ? "ipv6" : "ipv4");
  };
}

/**
 * Rate-limit key for a client address. IPv6 is grouped by /64, the usual per-customer allocation, so a client
 * can't bypass the limit by rotating addresses inside it. IPv4-mapped IPv6 is treated as IPv4.
 */
export function clientKey(ip: string | undefined): string {
  if (!ip) return "unknown";
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1];
  if (isIP(ip) !== 6) return ip;
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

function createWindowLimiter(max: number, windowMs: number): (key: string, now?: number) => boolean {
  const hits = new Map<string, number[]>();
  return (key, now = Date.now()) => {
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) { hits.set(key, recent); return false; }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 10_000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
    return true;
  };
}

function statusBody(job: JobRow) {
  const base = { job_id: job.id, id: job.id };
  switch (job.status) {
    case "awaiting_payment":
      return { ...base, status: "awaiting_payment", blockchainIdentifier: job.blockchain_identifier, input_hash: job.input_hash };
    case "running":
      return { ...base, status: "running" };
    case "completed":
      return { ...base, status: "completed", output: job.output, result: job.output, input_hash: job.input_hash, output_hash: job.output_hash };
    case "failed":
      return {
        ...base, status: "failed", error: "promise_not_met", reasons: job.failure_reasons ?? [],
        message: "The answer did not keep the published promise. No result was submitted, so your payment is refunded automatically after the submit-result deadline.",
      };
    case "expired":
      return { ...base, status: "failed", error: "payment_not_received", message: "No payment arrived before the pay-by time. Nothing was charged." };
  }
}

export function mip003Router(d: AppDeps): Router {
  const r = Router();

  r.get("/a/:apiId/availability", async (req, res, next) => {
    try {
      const loaded = await d.registry.get(req.params.apiId);
      if (!loaded || !(loaded.api.state === "live" || loaded.api.state === "registering")) {
        res.status(404).json({ status: "unavailable", message: "Unknown API." });
        return;
      }
      const snap = d.health.get(loaded.api.id);
      if (snap?.health === "down") {
        const first = snap.lastReasons[0];
        res.status(503).json({
          status: "unavailable",
          message: `${loaded.api.name} is Down${first ? `: ${first.op} ${first.reason}` : ""}.`,
          estimated_downtime_seconds: estimatedDowntimeSeconds(d.config),
        });
        return;
      }
      if (loaded.api.ownership_paused_at) {
        res.status(503).json({ status: "unavailable", message: `${loaded.api.name} is not selling right now: its owner has to confirm the API again.` });
        return;
      }
      res.json({ status: "available", type: "masumi-agent", message: `${loaded.api.name} is Live. Every answer is checked against a published promise.` });
    } catch (e) { next(e); }
  });

  r.get("/a/:apiId/input_schema", async (req, res, next) => {
    try {
      const loaded = await d.registry.get(req.params.apiId);
      const op = loaded ? escrowOperation(loaded) : undefined;
      if (!loaded || !op) { res.status(404).json({ error: "escrow_operation_not_set" }); return; }
      res.json({ input_data: toMip003Fields(op.row.input_schema) });
    } catch (e) { next(e); }
  });

  const allowStart = createWindowLimiter(START_JOB_LIMIT.max, START_JOB_LIMIT.windowMs);
  const allowTrustedStart = createWindowLimiter(START_JOB_TRUSTED_LIMIT.max, START_JOB_TRUSTED_LIMIT.windowMs);
  const isTrusted = trustedAddressMatcher(d.config.startJobTrustedCidrs);
  r.post("/a/:apiId/start_job", async (req, res, next) => {
    try {
      const allowed = isTrusted(req.ip) ? allowTrustedStart(clientKey(req.ip)) : allowStart(clientKey(req.ip));
      if (!allowed) {
        res.status(429).json({ error: "too_many_requests", message: "Too many jobs started from your address. Try again in a minute." });
        return;
      }
      const loaded = await d.registry.get(req.params.apiId);
      if (!loaded || loaded.api.state !== "live") { res.status(404).json({ error: "api_not_found" }); return; }
      const op = escrowOperation(loaded);
      if (!op?.rule) { res.status(503).json({ error: "escrow_not_configured", message: "This API has no escrow operation with a published promise." }); return; }
      const { input_data, identifier_from_purchaser: pid } = (req.body ?? {}) as { input_data?: unknown; identifier_from_purchaser?: unknown };
      if (typeof pid !== "string" || !PURCHASER_ID.test(pid)) {
        res.status(400).json({ error: "INVALID_INPUT", message: "identifier_from_purchaser must be 14-26 lowercase hex characters (even length)." });
        return;
      }
      const normalized = normalizeMip003Input(input_data);
      const checked = normalized ? op.validateInput(normalized) : { ok: false as const, reasons: ["input_data must be an object or a list of {key, value}"] };
      if (!checked.ok) { res.status(400).json({ error: "INVALID_INPUT", reasons: checked.reasons }); return; }
      const snap = d.health.get(loaded.api.id);
      if (snap?.health === "down") { res.status(503).json(downBody(d.config, snap)); return; }
      const paused = sellingPausedBody(loaded.api);
      if (paused) { res.status(503).json(paused); return; }
      if (!d.masumi) { res.status(503).json({ error: "escrow_unavailable", message: "Escrow payments are not configured on this gateway." }); return; }
      if (!loaded.api.agent_identifier) { res.status(503).json({ error: "agent_not_registered", message: "This API is not registered on Masumi yet." }); return; }

      const hash = inputHash(pid, input_data);
      const now = Date.now();
      const pr = await d.masumi.createPaymentRequest({
        agentIdentifier: loaded.api.agent_identifier, inputHash: hash, identifierFromPurchaser: pid,
        payByTime: new Date(now + d.config.escrow.payByMs), submitResultTime: new Date(now + d.config.escrow.submitResultMs),
        sellerReturnAddress: loaded.api.pay_to,
      });
      const jobId = newId("job");
      await insertJob(d.sql, {
        id: jobId, apiId: loaded.api.id, identifierFromPurchaser: pid, input: input_data, inputHash: hash,
        blockchainIdentifier: pr.blockchainIdentifier, payByTime: pr.payByTime, submitResultTime: pr.submitResultTime,
      });
      res.json({
        id: jobId, job_id: jobId, status: "awaiting_payment",
        blockchainIdentifier: pr.blockchainIdentifier,
        payByTime: pr.payByTime.getTime(), submitResultTime: pr.submitResultTime.getTime(),
        unlockTime: pr.unlockTime.getTime(), externalDisputeUnlockTime: pr.externalDisputeUnlockTime.getTime(),
        agentIdentifier: loaded.api.agent_identifier, sellerVKey: pr.sellerVKey,
        identifierFromPurchaser: pid, input_hash: hash,
        // Contract v1.1 G7: what the buyer must lock. Packs are ordered by price, so [0] is the cheapest.
        amounts: loaded.packs[0] ? [{ amount: loaded.packs[0].escrow_price_micros, unit: d.config.escrow.unit }] : [],
      });
    } catch (e) { next(e); }
  });

  r.get("/a/:apiId/status", async (req, res, next) => {
    try {
      const jobId = typeof req.query.job_id === "string" ? req.query.job_id : "";
      const job = jobId ? await getJob(d.sql, req.params.apiId, jobId) : null;
      if (!job) { res.status(404).json({ error: "JOB_NOT_FOUND" }); return; }
      // The job's output is the seller's body inside JSON.
      res.set(SELLER_BODY_HEADERS).json(statusBody(job));
    } catch (e) { next(e); }
  });

  return r;
}
