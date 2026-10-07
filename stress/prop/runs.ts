// Shared run counts: STRESS_LONG=1 (node stress/run.mjs --long) multiplies every property's runs by 20.
export const LONG = process.env.STRESS_LONG === "1";
export const runs = (n: number) => ({ numRuns: LONG ? n * 20 : n });
