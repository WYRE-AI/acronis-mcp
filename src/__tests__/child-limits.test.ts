/**
 * Memory limits of the REAL upstream child (WYREAI-711). One tenant's hostile or
 * runaway child must cost only its own child, never the wrapper or another
 * tenant's child, because the container has 0.5 Gi and an OOM kill would take
 * every tenant down.
 *
 * - a response over the cap is aborted by the egress guard while it streams, the
 *   child survives, and other tenants are unaffected;
 * - a child that exhausts its heap dies alone (--max-old-space-size), the pool
 *   drops it, the wrapper and the other child keep working, and the tenant gets
 *   a fresh child on its next call;
 * - a child that never answers `initialize` is killed after the spawn timeout.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcronisCredentials } from "../credentials.js";
import { handleToolCall, type ServerDeps } from "../mcp-server.js";
import { isOversizeResult } from "../oversize.js";
import { upstreamAllowlist } from "../tiers.js";
import { CHILD_MAX_OLD_SPACE_MB, CLOSE_TIMEOUT_MS, MAX_SEMI_SPACE_MB, UpstreamPool, createStdioSpawner, credentialKey } from "../upstream-pool.js";

const RECORDER = new URL("./fixtures/record-child.cjs", import.meta.url).pathname;
const base = { baseUrl: "https://eu8-cloud.acronis.com", clientSecret: "dummy-secret" };
const BIG: AcronisCredentials = { ...base, clientId: "tenant-big" };
const OK: AcronisCredentials = { ...base, clientId: "tenant-ok" };
const SIZED: AcronisCredentials = { ...base, clientId: "tenant-sized" };
const REFLECT: AcronisCredentials = { ...base, clientId: "tenant-reflect" };
/** What a real Acronis 400 might echo back from the request, and what the egress guard says. */
const MARKER = "Acronis response is larger than 262144 bytes and was not read";
/** A response just under the cap, as a list of small objects the way Acronis returns them. */
const NEAR_CAP_BODY = JSON.stringify({
  items: Array.from({ length: 1_600 }, (_, i) => ({ id: `${i}`.padStart(36, "0"), message: "x".repeat(100) })),
});

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

interface ChildRecord {
  pid: number;
  execArgv: string[];
  env: Record<string, string>;
}

let fake: Server;
let fakeOrigin: string;
let recordDir: string;
/** Bytes the fake managed to send to the hostile tenant before the child stopped reading. */
let hostileBytesSent = 0;

beforeAll(async () => {
  recordDir = mkdtempSync(join(tmpdir(), "acronis-limits-rec-"));
  fake = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/idp/token")) {
        const clientId = new URLSearchParams(body).get("client_id") ?? "";
        const jwt = `${b64({ alg: "none" })}.${b64({ cid: clientId, scope: [{ tid: "00000000-0000-0000-0000-000000000000" }] })}.sig`;
        res.end(JSON.stringify({ access_token: jwt, expires_in: 3600, token_type: "bearer" }));
        return;
      }
      const bearer = String(req.headers.authorization ?? "").replace(/^Bearer /i, "");
      const claims = bearer ? JSON.parse(Buffer.from(bearer.split(".")[1] ?? "", "base64url").toString("utf8") || "{}") : {};
      if (claims.cid === REFLECT.clientId && !req.url?.includes("resolve_ids")) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: { message: `invalid filter: ${MARKER}` } }));
        return;
      }
      if (claims.cid === SIZED.clientId && !req.url?.includes("resolve_ids")) {
        res.end(NEAR_CAP_BODY);
        return;
      }
      if (req.url?.includes("resolve_ids") || claims.cid !== BIG.clientId) {
        res.end(JSON.stringify({ items: [{ ok: true }] }));
        return;
      }
      // The hostile tenant: an endless chunked response. Backpressure stops us once the child stops reading.
      res.write('{"items":[');
      const chunk = `${JSON.stringify({ pad: "x".repeat(1000) })},`;
      const pump = () => {
        while (hostileBytesSent < 200 * 1024 * 1024) {
          hostileBytesSent += chunk.length;
          if (!res.write(chunk)) return void res.once("drain", pump);
        }
        res.end("{}]}");
      };
      pump();
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  fakeOrigin = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});

afterAll(async () => {
  fake.closeAllConnections();
  await new Promise<void>((r) => fake.close(() => r()));
  rmSync(recordDir, { recursive: true, force: true });
});

beforeEach(() => {
  hostileBytesSent = 0;
  for (const f of readdirSync(recordDir)) rmSync(join(recordDir, f));
});

const pools: UpstreamPool[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.close()));
});

function newPool(extraEnv: Record<string, string> = {}, spawnTimeoutMs?: number) {
  const pool = new UpstreamPool({
    toolsInclude: upstreamAllowlist(false),
    memoryLimitBytes: 2 ** 30,
    spawner: createStdioSpawner(
      { API_BASE_URL: fakeOrigin, NODE_OPTIONS: `--require ${RECORDER}`, ACRONIS_TEST_RECORD_DIR: recordDir, ...extraEnv },
      spawnTimeoutMs ? { spawnTimeoutMs } : {}
    ),
  });
  pools.push(pool);
  return pool;
}

const records = (): ChildRecord[] =>
  readdirSync(recordDir).map((f) => JSON.parse(readFileSync(join(recordDir, f), "utf8")) as ChildRecord);
const pidOf = (tenant: AcronisCredentials) => records().find((r) => r.env.OAUTH_CLIENT_ID === tenant.clientId)?.pid as number;
const call = (pool: UpstreamPool, tenant: AcronisCredentials) =>
  pool.withConnection(tenant, (c) => c.callTool("fetch_all_alerts", {}));

describe("child memory limits (real upstream child)", () => {
  it("starts the real upstream with a V8 heap cap", async () => {
    const pool = newPool();
    await pool.withConnection(OK, (c) => c.listToolNames());
    const [child] = records();
    expect(child.execArgv).toContain(`--max-old-space-size=${CHILD_MAX_OLD_SPACE_MB}`);
    expect(child.execArgv).toContain(`--max-semi-space-size=${MAX_SEMI_SPACE_MB}`);
    expect(child.execArgv.some((a) => a.endsWith("child-egress-guard.cjs"))).toBe(true);
  }, 60_000);

  it("aborts a hostile endless response, leaves the child and other tenants working", async () => {
    const pool = newPool();
    await pool.withConnection(OK, (c) => c.listToolNames());
    const result = await call(pool, BIG);
    expect(JSON.stringify(result)).toContain("larger than 262144 bytes");
    expect(isOversizeResult(result)).toBe(true); // the wrapper recognises what the real child says
    // The child stopped reading almost at once: the fake could send only a little of its 200 MiB.
    expect(hostileBytesSent).toBeLessThan(8 * 1024 * 1024);
    // Both children are still up and answer, and the other tenant never saw the hostile data.
    expect(pool.keys().sort()).toEqual([credentialKey(BIG), credentialKey(OK)].sort());
    expect(JSON.stringify(await call(pool, OK))).toContain("ok");
    expect(alive(pidOf(BIG))).toBe(true);
    expect(alive(pidOf(OK))).toBe(true);
  }, 60_000);

  it("tells a genuine oversize from an upstream 400 that quotes the marker, with the real child", async () => {
    const pool = newPool();
    const deps: ServerDeps = { writes: false, pool };
    // Genuine: the guard aborted the response, so the model is told to ask for less.
    const genuine = await handleToolCall(deps, BIG, "acronis_fetch_all_alerts", {});
    expect(JSON.parse(genuine.content[0].text).error.code).toBe("response_too_large");
    // Forged: the 400 body echoes the marker. It must come through as the real upstream error.
    const raw = await call(pool, REFLECT);
    expect(raw.isError).toBe(true);
    expect(JSON.stringify(raw)).toContain(MARKER); // the marker really is in the result...
    expect(isOversizeResult(raw)).toBe(false); // ...and still is not taken for an oversize
    const reflected = await handleToolCall(deps, REFLECT, "acronis_fetch_all_alerts", {});
    expect(reflected.isError).toBe(true);
    const error = JSON.parse(reflected.content[0].text).error;
    expect(error.code).toBe("upstream_error"); // the real error, not response_too_large
    expect(error.message).toMatch(/^HTTP 400/);
  }, 60_000);

  it("runs several calls that each return nearly the cap one at a time in the same child, and the child survives", async () => {
    expect(NEAR_CAP_BODY.length).toBeGreaterThan(200 * 1024);
    expect(NEAR_CAP_BODY.length).toBeLessThan(256 * 1024);
    const pool = newPool();
    const results = await Promise.all(Array.from({ length: 4 }, () => call(pool, SIZED)));
    for (const r of results) {
      expect(r.isError).toBeFalsy();
      expect(JSON.stringify(r)).toContain("0000000000000000000000000000000000"); // the list itself came back
    }
    expect(records().filter((r) => r.env.OAUTH_CLIENT_ID === SIZED.clientId)).toHaveLength(1); // one child, never restarted
    expect(alive(pidOf(SIZED))).toBe(true);
  }, 60_000);

  it("kills only the child that exhausts its heap; the wrapper and other tenants keep working", async () => {
    const pool = newPool({ ACRONIS_TEST_HOG: "1" });
    await pool.withConnection(BIG, (c) => c.listToolNames());
    await pool.withConnection(OK, (c) => c.listToolNames());
    const [bigPid, okPid] = [pidOf(BIG), pidOf(OK)];
    expect(new Set([bigPid, okPid]).size).toBe(2);

    process.kill(bigPid, "SIGUSR2"); // the BIG child now allocates until its 80 MiB heap cap kills it

    await vi.waitFor(() => expect(alive(bigPid)).toBe(false), { timeout: 30_000, interval: 100 });
    await vi.waitFor(() => expect(pool.keys()).toEqual([credentialKey(OK)]), { timeout: 10_000 });
    expect(alive(okPid)).toBe(true); // the other tenant's child is untouched
    expect(JSON.stringify(await call(pool, OK))).toContain("ok"); // and still answers; this process is the wrapper

    // The crashed tenant gets a fresh child on its next call.
    expect(JSON.stringify(await call(pool, BIG))).toBeDefined();
    const bigPids = records().filter((r) => r.env.OAUTH_CLIENT_ID === BIG.clientId).map((r) => r.pid);
    expect(bigPids).toHaveLength(2); // the dead child and its replacement
    expect(new Set(bigPids).size).toBe(2);
  }, 90_000);

  it("closing a child that ignores EOF and SIGTERM ends in SIGKILL, within the pool's close bound", async () => {
    const pool = newPool({ ACRONIS_TEST_IMMORTAL: "1" });
    await pool.withConnection(OK, (c) => c.listToolNames());
    const pid = pidOf(OK);
    expect(alive(pid)).toBe(true);
    const started = Date.now();
    await pool.close(); // stdin EOF (2 s), SIGTERM (2 s), then SIGKILL
    const took = Date.now() - started;
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5_000, interval: 50 });
    expect(took).toBeGreaterThanOrEqual(3_500); // it really held out against EOF and SIGTERM
    expect(took).toBeLessThan(CLOSE_TIMEOUT_MS); // and the pool did not have to give up waiting
  }, 30_000);

  it("kills a child that never answers initialize once the spawn timeout passes", async () => {
    const silent = createServer(() => undefined); // accepts the token request and never answers
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(silent.address() as AddressInfo).port}`;
    try {
      const pool = newPool({ API_BASE_URL: origin }, 1_500);
      const started = Date.now();
      await expect(pool.withConnection(OK, (c) => c.listToolNames())).rejects.toThrow(/timed out|timeout/i);
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(pool.size).toBe(0);
      const pid = pidOf(OK);
      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 10_000, interval: 100 });
    } finally {
      silent.closeAllConnections();
      await new Promise<void>((r) => silent.close(() => r()));
    }
  }, 60_000);
});
