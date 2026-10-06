import { createPaymentRequest, getPaymentState, submitResult } from "@hirakumi/masumi";
import type { MasumiPort } from "./masumi-port";

export function masumiPortFrom(c: { baseUrl: string; token: string }): MasumiPort {
  const cfg = { baseUrl: c.baseUrl, token: c.token, network: "Preprod" as const };
  return {
    createPaymentRequest: (p) => createPaymentRequest(cfg, p),
    getPaymentState: (id) => getPaymentState(cfg, id),
    submitResult: (id, hash) => submitResult(cfg, id, hash),
  };
}
