import type { Sql } from "../db";
import { firstFailedStep } from "../flow";
import { progressFor, type ApiProgress } from "../progress";
import { buildTimeline } from "../timeline";
import type { Api } from "../types";
import { listOnboardSteps } from "./apis";

export async function loadProgress(sql: Sql, api: Pick<Api, "id" | "state">): Promise<ApiProgress> {
  const steps = await listOnboardSteps(sql, api.id);
  return progressFor(api, buildTimeline(api.state, steps), firstFailedStep(steps));
}
