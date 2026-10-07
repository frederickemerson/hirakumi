import { statusOnlyRefusal } from "./answer-format";
import type { Sql } from "./db";
import { checkExposure, exposureRefusal } from "./exposure";
import { reloadQuietly } from "./gateway";
import { errorJson, json } from "./http";
import { transitionState } from "./repo/apis";
import { listLatestRules } from "./repo/rules";
import type { Api } from "./types";

/**
 * priced -> registering, for the review page and the one-time publish link (/act/<token>). The caller has checked
 * that sellerId owns the API (a session, or the owner's wallet signature).
 */
export async function publishApi(sql: Sql, api: Api, sellerId: string): Promise<Response> {
  // A text promise that only checks the status would pass an error page sent with status 200. A phrase only
  // makes a promise stricter, so checking before the state change can't let a status-only promise through.
  if (api.state === "rule_built" || api.state === "priced") {
    const refusal = statusOnlyRefusal(await listLatestRules(sql, api.id));
    if (refusal) return errorJson(409, refusal);
  }
  // The leak check, run again now (never a stored result): an API anyone can call for free without the seller's key
  // would never sell through Hirakumi, so it is not published. A check that could not tell blocks too, with a retry.
  // Only a priced API gets this far; listings already live are not affected.
  if (api.state === "priced") {
    const report = await checkExposure(sql, api.id);
    const refusal = report ? exposureRefusal(report) : null;
    if (refusal) return errorJson(409, refusal);
  }
  // Only 'priced' can publish; the conditional update makes a double click a no-op.
  const moved = await transitionState(sql, { apiId: api.id, sellerId, from: ["priced"], to: "registering" });
  if (!moved) return errorJson(409, "Save a price before publishing. If you already published, reload the page.");
  await reloadQuietly(api.id);
  return json({ state: "registering" });
}
