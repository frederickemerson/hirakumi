import { outputHash } from "@hirakumi/core";
import {
  claimJob, expireJob, failJob, insertCall, listJobsAwaitingPayment, listUnsubmittedPasses, markJobCompleted,
  resetInterruptedJobs, storeJobOutput, type JobRow, type Sql,
} from "@hirakumi/db";
import type { GatewayConfig } from "./config";
import type { MasumiPort } from "./masumi-port";
import { escrowOperation, type ApiRegistry } from "./registry";
import { normalizeMip003Input, runOperation } from "./upstream";

export type JobRunnerDeps = {
  sql: Sql; registry: ApiRegistry; masumi: MasumiPort;
  config: Pick<GatewayConfig, "upstreamTimeoutMs" | "demoMode">;
};

export class JobRunner {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  constructor(private readonly d: JobRunnerDeps) {}

  start(): void {
    void resetInterruptedJobs(this.d.sql)
      .then((n) => { if (n) console.log(`[jobs] re-queued ${n} interrupted job(s)`); })
      .catch((e) => console.error("[jobs] could not re-queue interrupted jobs:", e));
    this.timer = setInterval(() => { void this.tick(); }, this.d.config.demoMode ? 5_000 : 10_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Retries first (snapshot taken before this tick's new work), so a submit that fails now is retried next tick.
      for (const job of await listUnsubmittedPasses(this.d.sql)) {
        await this.submit(job).catch((e) => console.error(`[jobs] submit ${job.id}:`, (e as Error).message));
      }
      for (const job of await listJobsAwaitingPayment(this.d.sql)) {
        await this.advance(job).catch((e) => console.error(`[jobs] ${job.id}:`, e));
      }
    } catch (e) {
      console.error("[jobs] tick failed:", e);
    } finally {
      this.running = false;
    }
  }

  private async advance(job: JobRow): Promise<void> {
    if (!job.blockchain_identifier) return;
    const state = await this.d.masumi.getPaymentState(job.blockchain_identifier);
    if (state !== "FundsLocked") {
      if (job.pay_by_time && Date.now() > job.pay_by_time.getTime()) await expireJob(this.d.sql, job.id);
      return;
    }
    if (!(await claimJob(this.d.sql, job.id))) return;

    const loaded = await this.d.registry.get(job.api_id);
    const op = loaded ? escrowOperation(loaded) : undefined;
    const normalized = normalizeMip003Input(job.input);
    if (!loaded || !op?.rule || !normalized) {
      await failJob(this.d.sql, job.id, ["the escrow operation is no longer available"]);
      return;
    }
    const checked = op.validateInput(normalized);
    const outcome = await runOperation(loaded.api, op, checked.ok ? checked.value : normalized, { timeoutMs: this.d.config.upstreamTimeoutMs });
    const outHash = outcome.result ? outputHash(job.identifier_from_purchaser, outcome.result.body) : null;
    await insertCall(this.d.sql, {
      kind: "escrow", jobId: job.id, blockchainId: job.blockchain_identifier, apiId: loaded.api.id, opId: op.row.op_id,
      ruleId: op.ruleRow?.id ?? null, execution: outcome.execution, verdict: outcome.verdict, reasons: outcome.reasons,
      latencyMs: outcome.latencyMs, inputHash: job.input_hash, outputHash: outHash,
    });
    if (!(outcome.execution === "upstream_ok" && outcome.verdict === "pass" && outcome.result && outHash)) {
      await failJob(this.d.sql, job.id, outcome.reasons.length ? outcome.reasons : [`upstream ${outcome.execution}`]);
      return; // no result submitted → Masumi refunds after submitResultTime
    }
    await storeJobOutput(this.d.sql, job.id, outcome.result.body, outHash);
    await this.submit({ ...job, status: "running", output: outcome.result.body, output_hash: outHash });
  }

  private async submit(job: JobRow): Promise<void> {
    if (!job.blockchain_identifier || !job.output_hash) return;
    if (job.submit_result_time && Date.now() > job.submit_result_time.getTime()) {
      await failJob(this.d.sql, job.id, ["the result was ready after the submit-result deadline; the buyer is refunded automatically"]);
      return;
    }
    await this.d.masumi.submitResult(job.blockchain_identifier, job.output_hash);
    await markJobCompleted(this.d.sql, job.id);
  }
}
