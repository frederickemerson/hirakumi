#!/usr/bin/env node
// Hirakumi stress and abuse suite. Local only: a throwaway Postgres database, a stub facilitator that refuses every
// payment, a local seller, and the gateway started from this checkout. Nothing here reaches a real network service.
//
//   node stress/run.mjs            default run (about 5 minutes)
//   node stress/run.mjs --long     heavier: 20x property runs, 300k-call soak, longer throughput
//   node stress/run.mjs --only=prop,gateway,web,live      pick parts
//   STRESS_ONLY=throughput,race node stress/run.mjs --only=live      pick live scenarios
//
// Needs the dev Postgres (pnpm db:up): postgres://hirakumi:hirakumi@localhost:5432. Override with STRESS_PG_URL
// (the server URL; database names are fixed and must contain "stress"/"test").
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const args = process.argv.slice(2);
const LONG = args.includes("--long");
const only = (args.find((a) => a.startsWith("--only="))?.slice(7).split(",")) ?? ["prop", "gateway", "web", "live"];
const PG = process.env.STRESS_PG_URL ?? "postgres://hirakumi:hirakumi@localhost:5432";
const pgHost = new URL(PG).hostname;
if (!["localhost", "127.0.0.1", "::1"].includes(pgHost)) throw new Error(`STRESS_PG_URL must be local, got ${pgHost}`);
const dbUrl = (name) => { const u = new URL(PG); u.pathname = `/${name}`; return u.toString(); };
const DBS = { live: "hirakumi_stress", gateway: "hirakumi_stress_test", web: "hirakumi_stress_web_test" };
const PORTS = { gw: Number(process.env.STRESS_GW_PORT ?? 4931), seller: Number(process.env.STRESS_SELLER_PORT ?? 4910), fac: Number(process.env.STRESS_FAC_PORT ?? 4999) };

/** A clean environment: never the developer's .env (it can hold production URLs and keys). */
const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? "/tmp", ...(LONG ? { STRESS_LONG: "1" } : {}) };
const children = new Set();
const cleanup = () => { for (const c of children) { try { c.kill("SIGTERM"); } catch { /* gone */ } } };
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

async function freshDb(name) {
  if (!/stress/.test(name)) throw new Error(`refusing to recreate ${name}`);
  const a = postgres(dbUrl("postgres"), { max: 1, onnotice: () => {} });
  try {
    await a.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${name}' and pid <> pg_backend_pid()`);
    await a.unsafe(`drop database if exists ${name}`);
    await a.unsafe(`create database ${name}`);
  } finally { await a.end(); }
}

function run(cmd, argv, opts) {
  return new Promise((resolve) => {
    const c = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    children.add(c);
    let out = "";
    c.stdout.on("data", (d) => { out += String(d).replace(/\x1b\[[0-9;]*m/g, ""); process.stdout.write(d); });
    c.stderr.on("data", (d) => { out += String(d).replace(/\x1b\[[0-9;]*m/g, ""); if (opts?.showErr !== false) process.stderr.write(d); });
    c.on("exit", (code) => { children.delete(c); resolve({ code, out }); });
  });
}
function background(name, cmd, argv, opts) {
  const c = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"], ...opts });
  children.add(c);
  let log = "";
  const keep = (d) => { log = (log + d).slice(-20_000); };
  c.stdout.on("data", keep);
  c.stderr.on("data", keep);
  c.on("exit", (code) => { children.delete(c); if (code && code !== 143 && !c.killed) console.error(`[${name}] exited ${code}\n${log}`); });
  return { proc: c, log: () => log };
}
async function waitFor(url, ms = 60_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const summary = [];
const t0 = Date.now();
const vitest = join(repo, "node_modules/.bin/vitest");

if (only.includes("prop") || only.includes("gateway")) {
  await freshDb(DBS.gateway);
  const files = [...(only.includes("prop") ? ["prop"] : []), ...(only.includes("gateway") ? ["gateway"] : [])];
  console.log(`\n== vitest: ${files.join(" + ")} ==`);
  const r = await run(vitest, ["run", ...files], { cwd: here, env: { ...baseEnv, TEST_DATABASE_URL: dbUrl(DBS.gateway) } });
  summary.push({ part: files.join("+"), ok: r.code === 0, line: (r.out.match(/Tests\s+.*$/m) ?? ["?"])[0] });
}

if (only.includes("web")) {
  await freshDb(DBS.web);
  console.log("\n== vitest: web routes ==");
  const r = await run(join(repo, "apps/web/node_modules/.bin/vitest"), ["run", "--config", "vitest.config.ts"], { cwd: join(here, "web"), env: { ...baseEnv, TEST_DATABASE_URL: dbUrl(DBS.web) } });
  summary.push({ part: "web", ok: r.code === 0, line: (r.out.match(/Tests\s+.*$/m) ?? ["?"])[0] });
}

if (only.includes("live")) {
  console.log("\n== live: gateway process under load ==");
  await freshDb(DBS.live);
  const INTERNAL = `stress-${randomBytes(16).toString("hex")}`;
  const GW = `http://127.0.0.1:${PORTS.gw}`;
  const fac = background("facilitator", process.execPath, [join(here, "load/facilitator.mjs")], { env: { ...baseEnv, FAC_PORT: String(PORTS.fac) } });
  const seller = background("seller", process.execPath, [join(here, "load/seller.mjs")], { env: { ...baseEnv, SELLER_PORT: String(PORTS.seller) } });
  const gw = background("gateway", process.execPath, ["--max-old-space-size=256", "--import", "tsx", "src/main.ts"], {
    cwd: join(repo, "apps/gateway"),
    env: {
      ...baseEnv, NODE_ENV: "production",
      DATABASE_URL: dbUrl(DBS.live), INTERNAL_TOKEN: INTERNAL, PUBLIC_BASE_URL: GW, GATEWAY_PORT: String(PORTS.gw),
      FACILITATOR_URL: `http://127.0.0.1:${PORTS.fac}`, DEMO_MODE: "1", ALLOW_INSECURE_UPSTREAM: "1", PACK_MODE: "hybrid",
      // Escrow settings without chain access: hybrid offers say what the policy recommends and settle direct.
      HIRAKUMI_FEE_ADDRESS: "addr_test1vrl0alh7lml0alh7lml0alh7lml0alh7lml0alh7lml0alsu6gx0s", ESCROW_CLOSER_VKH: "c1".repeat(28),
      TRY_LIVE_APIS: "",
    },
  });
  const up = (await waitFor(`${GW}/healthz`)) && (await waitFor(`http://127.0.0.1:${PORTS.fac}/count`)) && (await waitFor(`http://127.0.0.1:${PORTS.seller}/`));
  if (!up) {
    console.error(`[live] processes did not start\n${gw.log()}`);
    summary.push({ part: "live", ok: false, line: "did not start" });
  } else {
    const r = await run(join(repo, "node_modules/.bin/tsx"), [join(here, "load/scenarios.mts")], {
      cwd: here,
      env: {
        ...baseEnv, STRESS_GW: GW, STRESS_SELLER: `http://127.0.0.1:${PORTS.seller}`, STRESS_FAC: `http://127.0.0.1:${PORTS.fac}`,
        STRESS_DB: dbUrl(DBS.live), STRESS_INTERNAL_TOKEN: INTERNAL, STRESS_GW_PID: String(gw.proc.pid), STRESS_ONLY: process.env.STRESS_ONLY ?? "",
      },
    });
    const errors = gw.log().split("\n").filter((l) => /\[gateway\] (?!listening|migrations|PAYMENT|BUYER|OPERATOR|PACK_MODE|BLOCKFROST)|Error|uncaught/i.test(l)).slice(0, 20);
    if (errors.length) console.log(`\n[gateway log: errors]\n${errors.join("\n")}`);
    summary.push({ part: "live", ok: r.code === 0, line: (r.out.match(/LIVE .*$/m) ?? ["?"])[0] });
  }
  for (const p of [gw, seller, fac]) p.proc.kill("SIGTERM");
}

cleanup();
console.log(`\n== stress summary (${Math.round((Date.now() - t0) / 1000)} s${LONG ? ", --long" : ""}) ==`);
for (const s of summary) console.log(`${s.ok ? "PASS" : "FAIL"}  ${s.part.padEnd(14)} ${s.line}`);
process.exit(summary.every((s) => s.ok) ? 0 : 1);
