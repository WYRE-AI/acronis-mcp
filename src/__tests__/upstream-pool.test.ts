import { afterEach, describe, expect, it, vi } from "vitest";
import {
  UpstreamPool,
  buildChildEnv,
  credentialKey,
  poolOptionsFromEnv,
  resolveUpstreamBin,
  type Spawner,
  type UpstreamConnection,
} from "../upstream-pool.js";
import type { AcronisCredentials } from "../credentials.js";

const A: AcronisCredentials = { baseUrl: "https://us5-cloud.acronis.com", clientId: "a", clientSecret: "sa-secret" };
const B: AcronisCredentials = { baseUrl: "https://us5-cloud.acronis.com", clientId: "b", clientSecret: "sb-secret" };
const C: AcronisCredentials = { baseUrl: "https://eu2-cloud.acronis.com", clientId: "a", clientSecret: "sa-secret" };

function fakeSpawner() {
  const spawned: Array<{ creds: AcronisCredentials; include: readonly string[]; closed: boolean; onClose: () => void }> = [];
  const spawner: Spawner = async (creds, include, ctx) => {
    const rec = { creds, include, closed: false, onClose: ctx.onClose };
    spawned.push(rec);
    const conn: UpstreamConnection = {
      callTool: async (name) => ({ content: [{ type: "text", text: `${name}:${creds.clientId}` }] }),
      listToolNames: async () => [],
      close: async () => {
        rec.closed = true;
      },
    };
    return conn;
  };
  return { spawner, spawned };
}

const use = (p: UpstreamPool, c: AcronisCredentials) => p.withConnection(c, async () => undefined);

afterEach(() => vi.useRealTimers());

describe("credentialKey", () => {
  it("is a sha256 hex digest that differs per tuple and hides raw values", () => {
    const k = credentialKey(A);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(k).not.toContain("sa-secret");
    expect(credentialKey(B)).not.toBe(k);
    expect(credentialKey(C)).not.toBe(k);
    expect(credentialKey({ ...A })).toBe(k);
  });

  it("does not collide when fields are shifted across boundaries", () => {
    const x = credentialKey({ baseUrl: "https://a.acronis.com", clientId: "bc", clientSecret: "d" });
    const y = credentialKey({ baseUrl: "https://a.acronis.com", clientId: "b", clientSecret: "cd" });
    expect(x).not.toBe(y);
  });
});

describe("UpstreamPool", () => {
  it("spawns one child per distinct tuple and reuses it", async () => {
    const { spawner, spawned } = fakeSpawner();
    const pool = new UpstreamPool({ toolsInclude: ["fetch_tenant"], spawner });
    await use(pool, A);
    await use(pool, A);
    await use(pool, B);
    await use(pool, C);
    expect(spawned).toHaveLength(3);
    expect(pool.size).toBe(3);
    expect(spawned[0].include).toEqual(["fetch_tenant"]);
    await pool.close();
  });

  it("dedupes concurrent first calls for the same tuple", async () => {
    const { spawner, spawned } = fakeSpawner();
    const pool = new UpstreamPool({ toolsInclude: [], spawner });
    await Promise.all([use(pool, A), use(pool, A), use(pool, A)]);
    expect(spawned).toHaveLength(1);
    await pool.close();
  });

  it("routes each tenant's call to its own child", async () => {
    const { spawner } = fakeSpawner();
    const pool = new UpstreamPool({ toolsInclude: [], spawner });
    const ra = await pool.withConnection(A, (c) => c.callTool("t", {}));
    const rb = await pool.withConnection(B, (c) => c.callTool("t", {}));
    expect(JSON.stringify(ra)).toContain("t:a");
    expect(JSON.stringify(rb)).toContain("t:b");
    await pool.close();
  });

  it("evicts the least-recently-used entry beyond max and closes it", async () => {
    const { spawner, spawned } = fakeSpawner();
    const pool = new UpstreamPool({ toolsInclude: [], spawner, max: 2 });
    await use(pool, A);
    await use(pool, B);
    await use(pool, A); // A is now most recent; B is LRU
    await use(pool, C);
    await new Promise((r) => setTimeout(r, 0));
    expect(pool.size).toBe(2);
    expect(pool.keys()).toContain(credentialKey(A));
    expect(pool.keys()).toContain(credentialKey(C));
    expect(pool.keys()).not.toContain(credentialKey(B));
    expect(spawned.find((s) => s.creds === B)?.closed).toBe(true);
    expect(spawned.find((s) => s.creds === A)?.closed).toBe(false);
    await pool.close();
  });

  it("evicts idle entries after idleMs", async () => {
    let now = 1_000;
    const { spawner, spawned } = fakeSpawner();
    const pool = new UpstreamPool({ toolsInclude: [], spawner, idleMs: 600_000, now: () => now });
    await use(pool, A);
    now += 599_000;
    expect(pool.evictIdle()).toBe(0);
    now += 2_000;
    expect(pool.evictIdle()).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(pool.size).toBe(0);
    expect(spawned[0].closed).toBe(true);
    await use(pool, A); // respawns
    expect(spawned).toHaveLength(2);
    await pool.close();
  });

  it("does not close an in-use child that was evicted until the call ends", async () => {
    const { spawner, spawned } = fakeSpawner();
    const pool = new UpstreamPool({ toolsInclude: [], spawner, max: 1 });
    let release!: () => void;
    const held = pool.withConnection(A, () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 0));
    await use(pool, B);
    expect(spawned[0].closed).toBe(false);
    release();
    await held;
    await new Promise((r) => setTimeout(r, 0));
    expect(spawned[0].closed).toBe(true);
    await pool.close();
  });

  it("drops an entry when the child exits and respawns on next use", async () => {
    const { spawner, spawned } = fakeSpawner();
    const pool = new UpstreamPool({ toolsInclude: [], spawner });
    await use(pool, A);
    spawned[0].onClose();
    expect(pool.size).toBe(0);
    await use(pool, A);
    expect(spawned).toHaveLength(2);
    await pool.close();
  });

  it("does not cache a failed spawn", async () => {
    let n = 0;
    const spawner: Spawner = async () => {
      if (n++ === 0) throw new Error("boom");
      return { callTool: async () => ({}), listToolNames: async () => [], close: async () => undefined };
    };
    const pool = new UpstreamPool({ toolsInclude: [], spawner });
    await expect(use(pool, A)).rejects.toThrow("boom");
    expect(pool.size).toBe(0);
    await expect(use(pool, A)).resolves.toBeUndefined();
    await pool.close();
  });

  it("close() closes every child and refuses further use", async () => {
    const { spawner, spawned } = fakeSpawner();
    const pool = new UpstreamPool({ toolsInclude: [], spawner });
    await use(pool, A);
    await use(pool, B);
    await pool.close();
    expect(spawned.every((s) => s.closed)).toBe(true);
    expect(pool.size).toBe(0);
    await expect(use(pool, A)).rejects.toThrow(/closed/);
  });
});

describe("poolOptionsFromEnv", () => {
  it("defaults to 50 / 10 minutes and honours overrides", () => {
    expect(poolOptionsFromEnv({})).toEqual({ max: 50, idleMs: 600_000 });
    expect(poolOptionsFromEnv({ ACRONIS_POOL_MAX: "5", ACRONIS_POOL_IDLE_MS: "1000" })).toEqual({ max: 5, idleMs: 1000 });
    expect(poolOptionsFromEnv({ ACRONIS_POOL_MAX: "abc", ACRONIS_POOL_IDLE_MS: "-3" })).toEqual({ max: 50, idleMs: 600_000 });
  });
});

describe("child process environment", () => {
  it("contains only the allowed variables and never leaks the parent env", () => {
    const env = buildChildEnv(A, ["fetch_tenant", "fetch_user"], {
      PATH: "/usr/bin",
      NODE_ENV: "production",
      CONDUIT_S2S_SECRET: "must-not-leak",
      ACRONIS_CLIENT_SECRET: "must-not-leak-either",
      HOME: "/root",
    });
    expect(Object.keys(env).sort()).toEqual(
      ["API_BASE_URL", "MCP_TOOLS_INCLUDE", "MCP_TRANSPORT", "NODE_ENV", "OAUTH_CLIENT_ID", "OAUTH_CLIENT_SECRET", "PATH"].sort()
    );
    expect(env).toMatchObject({
      API_BASE_URL: A.baseUrl,
      OAUTH_CLIENT_ID: "a",
      OAUTH_CLIENT_SECRET: "sa-secret",
      MCP_TRANSPORT: "stdio",
      MCP_TOOLS_INCLUDE: "fetch_tenant,fetch_user",
    });
    expect(JSON.stringify(env)).not.toContain("must-not-leak");
  });

  it("resolves the pinned package's bin/cli.js", () => {
    expect(resolveUpstreamBin()).toMatch(/@acronis-platform[\\/]mcp[\\/]bin[\\/]cli\.js$/);
  });
});
