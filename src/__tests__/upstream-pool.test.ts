import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_POOL_MAX,
  MAX_FAILED_SPAWNS,
  MAX_POOL_MAX,
  PoolBusyError,
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

  it("never evicts a busy child: a new credential waits for a free slot", async () => {
    const { spawner, spawned } = fakeSpawner();
    const pool = new UpstreamPool({ toolsInclude: [], spawner, max: 1 });
    let release!: () => void;
    const held = pool.withConnection(A, () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 0));
    const waitingB = use(pool, B);
    await new Promise((r) => setTimeout(r, 10));
    expect(spawned).toHaveLength(1); // B has not displaced the busy A child
    expect(pool.keys()).toEqual([credentialKey(A)]);
    release();
    await held;
    await waitingB;
    expect(spawned).toHaveLength(2);
    expect(spawned[0].closed).toBe(true); // A was idle, so it made room for B
    expect(pool.keys()).toEqual([credentialKey(B)]);
    await pool.close();
  });

  it("reuses the busy child for the same credential instead of spawning a second one (A, B, A with max 1)", async () => {
    const { spawner, spawned } = fakeSpawner();
    const pool = new UpstreamPool({ toolsInclude: [], spawner, max: 1 });
    let release!: () => void;
    const held = pool.withConnection(A, () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 0));
    const waitingB = use(pool, B);
    await use(pool, A); // served by the existing A child while B waits
    expect(spawned).toHaveLength(1);
    release();
    await held;
    await waitingB;
    expect(spawned).toHaveLength(2);
    expect(spawned.filter((s) => s.creds.clientId === "a")).toHaveLength(1);
    await pool.close();
  });

  it("fails with PoolBusyError when no slot frees up within waitMs", async () => {
    const { spawner, spawned } = fakeSpawner();
    const pool = new UpstreamPool({ toolsInclude: [], spawner, max: 1, waitMs: 20 });
    let release!: () => void;
    const held = pool.withConnection(A, () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 0));
    await expect(use(pool, B)).rejects.toBeInstanceOf(PoolBusyError);
    expect(spawned).toHaveLength(1);
    release();
    await held;
    await pool.close();
  });

  it("close() also closes a retired child that is still serving a call", async () => {
    const { spawner, spawned } = fakeSpawner();
    const pool = new UpstreamPool({ toolsInclude: [], spawner });
    let release!: () => void;
    const held = pool.withConnection(A, () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 0));
    spawned[0].onClose(); // child reported exit while busy: retired but still in use
    expect(pool.size).toBe(0);
    await pool.close();
    expect(spawned[0].closed).toBe(true);
    release();
    await held;
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

  describe("failed spawns (negative cache)", () => {
    const okConn = (): UpstreamConnection => ({ callTool: async () => ({}), listToolNames: async () => [], close: async () => undefined });

    it("remembers a failed spawn per credential, so a bad credential does not respawn on every call", async () => {
      let attempts = 0;
      const spawner: Spawner = async () => {
        attempts++;
        throw new Error("invalid_client");
      };
      const pool = new UpstreamPool({ toolsInclude: [], spawner });
      for (let i = 0; i < 20; i++) await expect(use(pool, A)).rejects.toThrow("invalid_client");
      expect(attempts).toBe(1);
      expect(pool.size).toBe(0);
      await pool.close();
    });

    it("keys the failure by credential: another tenant is not affected", async () => {
      const spawner: Spawner = async (creds) => {
        if (creds.clientId === "a") throw new Error("invalid_client");
        return okConn();
      };
      const pool = new UpstreamPool({ toolsInclude: [], spawner });
      await expect(use(pool, A)).rejects.toThrow("invalid_client");
      await expect(use(pool, B)).resolves.toBeUndefined();
      await pool.close();
    });

    it("retries after the TTL, and a recovered credential works again", async () => {
      let now = 1_000;
      let attempts = 0;
      const spawner: Spawner = async () => {
        if (attempts++ === 0) throw new Error("boom");
        return okConn();
      };
      const pool = new UpstreamPool({ toolsInclude: [], spawner, failedSpawnTtlMs: 30_000, now: () => now });
      await expect(use(pool, A)).rejects.toThrow("boom");
      now += 29_000;
      await expect(use(pool, A)).rejects.toThrow("boom"); // still cached
      expect(attempts).toBe(1);
      now += 2_000;
      await expect(use(pool, A)).resolves.toBeUndefined(); // TTL over: respawns
      expect(attempts).toBe(2);
      await pool.close();
    });

    it("stores only a bounded number of failures and never the raw credential", async () => {
      const spawner: Spawner = async () => {
        throw new Error("nope");
      };
      const pool = new UpstreamPool({ toolsInclude: [], spawner });
      for (let i = 0; i < MAX_FAILED_SPAWNS + 50; i++) {
        await use(pool, { ...A, clientSecret: `secret-${i}` }).catch(() => undefined);
      }
      const cache = (pool as unknown as { failedSpawns: Map<string, unknown> }).failedSpawns;
      expect(cache.size).toBe(MAX_FAILED_SPAWNS);
      expect([...cache.keys()].every((k) => /^[0-9a-f]{64}$/.test(k))).toBe(true);
      await pool.close();
    });
  });

  describe("pool cap", () => {
    it("defaults to 3 children, which fit the 0.5 Gi container (3 x ~116 MiB + wrapper)", () => {
      expect(DEFAULT_POOL_MAX).toBe(3);
      expect(poolOptionsFromEnv({}).max).toBe(3);
    });

    it("clamps max to MAX_POOL_MAX and never spawns beyond it", async () => {
      const { spawner, spawned } = fakeSpawner();
      const pool = new UpstreamPool({ toolsInclude: [], spawner, max: 1_000, waitMs: 5 });
      const releases: Array<() => void> = [];
      const held: Array<Promise<void>> = [];
      for (let i = 0; i < MAX_POOL_MAX; i++) {
        held.push(pool.withConnection({ ...A, clientId: `t${i}` }, () => new Promise<void>((r) => releases.push(r))));
      }
      await new Promise((r) => setTimeout(r, 10));
      expect(spawned).toHaveLength(MAX_POOL_MAX);
      await expect(use(pool, { ...A, clientId: "one-too-many" })).rejects.toBeInstanceOf(PoolBusyError);
      expect(spawned).toHaveLength(MAX_POOL_MAX);
      releases.forEach((r) => r());
      await Promise.all(held);
      await pool.close();
    });

    it("refuses at once when the wait queue is full, without waiting out waitMs", async () => {
      const { spawner, spawned } = fakeSpawner();
      const pool = new UpstreamPool({ toolsInclude: [], spawner, max: 1, maxQueue: 2, waitMs: 60_000 });
      let release!: () => void;
      const held = pool.withConnection(A, () => new Promise<void>((r) => (release = r)));
      await new Promise((r) => setTimeout(r, 0));
      const queued = [1, 2].map((i) => use(pool, { ...B, clientId: `q${i}` }));
      await new Promise((r) => setTimeout(r, 10));
      const started = Date.now();
      await expect(use(pool, { ...B, clientId: "q3" })).rejects.toBeInstanceOf(PoolBusyError);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(spawned).toHaveLength(1);
      release();
      await held;
      await Promise.all(queued);
      await pool.close();
    });
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
  it("defaults to 3 / 10 minutes and honours overrides", () => {
    expect(poolOptionsFromEnv({})).toEqual({ max: 3, idleMs: 600_000 });
    expect(poolOptionsFromEnv({ ACRONIS_POOL_MAX: "5", ACRONIS_POOL_IDLE_MS: "1000" })).toEqual({ max: 5, idleMs: 1000 });
    expect(poolOptionsFromEnv({ ACRONIS_POOL_MAX: "abc", ACRONIS_POOL_IDLE_MS: "-3" })).toEqual({ max: 3, idleMs: 600_000 });
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
