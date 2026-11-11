#!/usr/bin/env node
// Sustained-load memory check for the pool sizing (WYREAI-711).
//
// Runs the BUILT wrapper (dist/, real HTTP server, real pool, real upstream
// children, the real egress guard) as its own process with the production
// flags, against a fake Acronis that returns realistic JSON lists of a given
// size, and samples the resident memory (RSS) of the wrapper plus every child
// while several callers on several tenants hammer it. It reports the peaks and
// fails when the total goes over a budget or a child crashes.
//
//   npm run build && node scripts/sustained-load.mjs
//
// Knobs (environment): LOAD_MEMORY_MB (container size the pool is told about,
// default 512), LOAD_BUDGET_MB (fail above this total RSS; default LOAD_MEMORY_MB),
// LOAD_TENANTS (2), LOAD_CALLERS (6), LOAD_SECONDS (6), LOAD_RESPONSE_KB
// (the response cap, so the worst response that still gets through),
// LOAD_WRAPPER_FLAGS (the wrapper's node flags; default: the ones in the Dockerfile CMD),
// LOAD_STALL_MS (100: how long the wrapper's event loop is blocked every 250 ms, as
// a 0.25 vCPU container does under load; 0 turns it off), LOAD_SLICE_MS (the pool's
// time slice, ACRONIS_POOL_SLICE_MS; default 10 s), LOAD_JSON=1 (one JSON line only).
// The container size is simulated by making process.constrainedMemory() report it.
// Callers are spread over the tenants in turn, so 6 callers on 2 tenants is 3 each.
//
// RSS is summed per process, so shared pages are counted once per process: the
// total is an upper bound. Numbers differ between macOS and Linux; re-run it in
// the image (`docker run -m 512m`) before trusting a size.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const num = (name, fallback) => Number(process.env[name] ?? fallback);

const MEMORY_MB = num("LOAD_MEMORY_MB", 512);
const BUDGET_MB = num("LOAD_BUDGET_MB", MEMORY_MB);
const TENANTS = num("LOAD_TENANTS", 2);
const CALLERS = num("LOAD_CALLERS", 6);
const SECONDS = num("LOAD_SECONDS", 6);
const RESPONSE_KB = num("LOAD_RESPONSE_KB", 250);
// The wrapper runs with the flags the image gives it.
const dockerCmd = /^CMD (\[.*\])\s*$/m.exec(readFileSync(join(root, "Dockerfile"), "utf8"));
const IMAGE_FLAGS = dockerCmd ? JSON.parse(dockerCmd[1]).filter((a) => a.startsWith("--")) : [];
const WRAPPER_FLAGS = process.env.LOAD_WRAPPER_FLAGS?.split(" ").filter(Boolean) ?? IMAGE_FLAGS;
const STALL_MS = num("LOAD_STALL_MS", 100);
const S2S_SECRET = "sustained-load-secret";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

/** A realistic list: many small objects, as Acronis returns, not one long string. */
function realisticBody(bytes) {
  const items = [];
  let size = 2;
  for (let i = 0; size < bytes - 250; i++) {
    const item = {
      id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
      severity: "warning",
      type: "BackupFailed",
      details: { message: "Backup of machine failed with error code 42", planName: `Daily plan ${i}`, resourceName: `host-${i}` },
    };
    items.push(item);
    size += JSON.stringify(item).length + 1;
  }
  return JSON.stringify({ items });
}

// ---- worker: the wrapper itself, started as `node <flags> sustained-load.mjs --worker` ----
if (process.argv[2] === "--worker") {
  // Pretend to be a container of this size, the way a cgroup limit shows up to Node.
  process.constrainedMemory = () => Number(process.env.LOAD_MEMORY_MB) * 1024 * 1024;
  const { startHttpTransport } = await import(join(root, "dist", "index.js"));
  const { createStdioSpawner, setDefaultSpawner } = await import(join(root, "dist", "upstream-pool.js"));
  setDefaultSpawner(createStdioSpawner({ API_BASE_URL: process.env.LOAD_FAKE_ORIGIN }));
  const server = await startHttpTransport();
  if (STALL_MS > 0) {
    setInterval(() => {
      const until = Date.now() + STALL_MS;
      while (Date.now() < until);
    }, 250);
  }
  console.log(`LISTENING ${server.address().port}`);
  await new Promise(() => undefined);
}

// ---- parent ----
const body = realisticBody(RESPONSE_KB * 1024);
const fake = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  req.resume();
  req.on("end", () => {
    if (req.url.endsWith("/idp/token")) {
      return res.end(JSON.stringify({ access_token: `${b64({ alg: "none" })}.${b64({ scope: [{ tid: "0" }] })}.s`, expires_in: 3600 }));
    }
    res.end(req.url.includes("resolve_ids") ? JSON.stringify({ items: [] }) : body);
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const fakeOrigin = `http://127.0.0.1:${fake.address().port}`;

const worker = spawn(process.execPath, [...WRAPPER_FLAGS, join(here, "sustained-load.mjs"), "--worker"], {
  env: {
    PATH: process.env.PATH,
    LOAD_FAKE_ORIGIN: fakeOrigin,
    CONDUIT_S2S_SECRET: S2S_SECRET,
    AUTH_MODE: "gateway",
    MCP_HTTP_PORT: "0",
    MCP_HTTP_HOST: "127.0.0.1",
    LOG_LEVEL: "error",
    NODE_ENV: "production",
    LOAD_MEMORY_MB: String(MEMORY_MB),
    LOAD_STALL_MS: String(STALL_MS),
    ...(process.env.LOAD_SLICE_MS ? { ACRONIS_POOL_SLICE_MS: process.env.LOAD_SLICE_MS } : {}),
  },
  stdio: ["ignore", "pipe", "inherit"],
});
const port = await new Promise((resolve, reject) => {
  worker.on("exit", (code) => reject(new Error(`wrapper exited early (${code})`)));
  worker.stdout.on("data", (d) => {
    const m = /LISTENING (\d+)/.exec(String(d));
    if (m) resolve(Number(m[1]));
  });
});
const endpoint = `http://127.0.0.1:${port}/mcp`;

/** RSS (MiB) of the wrapper and of each of its children, from one `ps`. */
function sample() {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number));
  const wrapper = rows.find(([pid]) => pid === worker.pid);
  const children = rows.filter(([, ppid]) => ppid === worker.pid);
  return {
    wrapper: (wrapper?.[2] ?? 0) / 1024,
    children: new Map(children.map(([pid, , rss]) => [pid, rss / 1024])),
  };
}

async function call(tenant) {
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", S2S_SECRET).update(`t=${t}`).digest("hex");
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-gateway-s2s": `t=${t},v1=${sig}`,
      "x-acronis-base-url": "https://eu8-cloud.acronis.com",
      "x-acronis-client-id": `load-tenant-${tenant}`,
      "x-acronis-client-secret": `load-secret-${tenant}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "acronis_fetch_all_alerts", arguments: {} } }),
  });
  const text = await res.text();
  if (res.status !== 200) return { kind: "http_error", detail: `${res.status} ${text.slice(0, 80)}` };
  if (text.includes("rate_limited")) return { kind: "rate_limited" };
  if (text.includes('"isError":true') || text.includes("upstream_unavailable")) return { kind: "error", detail: text.slice(0, 160) };
  return { kind: "ok" };
}

// Warm one child per tenant (or as many as fit), then record the idle size.
for (let t = 0; t < TENANTS; t++) await call(t);
await new Promise((r) => setTimeout(r, 1000));
const idle = sample();
const idleChildren = [...idle.children.values()];

const seenPids = new Set(idle.children.keys());
let peakWrapper = 0;
let peakChild = 0;
let peakTotal = 0;
let peakProcesses = 0;
const sampler = setInterval(() => {
  const s = sample();
  const kids = [...s.children.values()];
  for (const pid of s.children.keys()) seenPids.add(pid);
  peakWrapper = Math.max(peakWrapper, s.wrapper);
  peakChild = Math.max(peakChild, ...kids, 0);
  peakTotal = Math.max(peakTotal, s.wrapper + kids.reduce((a, b) => a + b, 0));
  peakProcesses = Math.max(peakProcesses, kids.length);
}, 20);

const counts = { ok: 0, rate_limited: 0, error: 0, http_error: 0 };
// Per tenant: how many calls got an answer, how many were refused, and the longest a call took.
const perTenant = Array.from({ length: TENANTS }, () => ({ ok: 0, rate_limited: 0, failed: 0, worstMs: 0 }));
const details = [];
const end = Date.now() + SECONDS * 1000;
await Promise.all(
  Array.from({ length: CALLERS }, async (_, i) => {
    const tenant = i % TENANTS;
    while (Date.now() < end) {
      const began = Date.now();
      const r = await call(tenant).catch((e) => ({ kind: "http_error", detail: String(e.message) }));
      counts[r.kind]++;
      const t = perTenant[tenant];
      if (r.kind === "ok" || r.kind === "rate_limited") t[r.kind]++;
      else t.failed++;
      t.worstMs = Math.max(t.worstMs, Date.now() - began);
      if (r.detail && details.length < 3) details.push(r.detail);
    }
  })
);
clearInterval(sampler);
const stillAlive = worker.exitCode === null;
worker.kill("SIGTERM");
fake.close();

const r1 = (n) => Math.round(n);
const result = {
  memoryMb: MEMORY_MB,
  budgetMb: BUDGET_MB,
  tenants: TENANTS,
  callers: CALLERS,
  responseKb: RESPONSE_KB,
  wrapperFlags: WRAPPER_FLAGS,
  calls: counts,
  perTenant,
  idle: { wrapperMb: r1(idle.wrapper), childrenMb: idleChildren.map(r1) },
  peak: { wrapperMb: r1(peakWrapper), childMb: r1(peakChild), totalMb: r1(peakTotal), liveChildren: peakProcesses },
  childPidsSeen: seenPids.size,
  wrapperSurvived: stillAlive,
  failures: [],
};
if (counts.error + counts.http_error > 0) result.failures.push(`${counts.error + counts.http_error} calls failed (a crashed child shows up as upstream_unavailable): ${details.join(" | ")}`);
if (!stillAlive) result.failures.push("the wrapper process died");
if (peakTotal > BUDGET_MB) result.failures.push(`peak total RSS ${r1(peakTotal)} MiB is over the ${BUDGET_MB} MiB budget`);
if (counts.ok === 0) result.failures.push("no call succeeded");

if (process.env.LOAD_JSON === "1") {
  console.log(JSON.stringify(result));
} else {
  console.log(`container ${MEMORY_MB} MiB, wrapper flags [${WRAPPER_FLAGS.join(" ")}], ${CALLERS} callers on ${TENANTS} tenants, ${RESPONSE_KB} KiB responses, ${SECONDS}s`);
  console.log(`calls: ${counts.ok} ok, ${counts.rate_limited} rate_limited, ${counts.error + counts.http_error} failed`);
  perTenant.forEach((t, i) => console.log(`  tenant ${i}: ${t.ok} ok, ${t.rate_limited} rate_limited, ${t.failed} failed, longest call ${t.worstMs} ms`));
  console.log(`idle: wrapper ${result.idle.wrapperMb} MiB, children ${result.idle.childrenMb.join(" + ") || "none"} MiB`);
  console.log(`peak: wrapper ${result.peak.wrapperMb}, one child ${result.peak.childMb}, TOTAL ${result.peak.totalMb} MiB (budget ${BUDGET_MB}), most live children ${peakProcesses}, child pids seen ${seenPids.size}`);
  console.log(result.failures.length ? `FAILED: ${result.failures.join("; ")}` : "OK");
}
process.exit(result.failures.length ? 1 : 0);
