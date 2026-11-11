import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_CALLS_PER_CHILD,
  MAX_FAILED_SPAWNS,
  MAX_POOL_MAX,
  PoolBusyError,
  UpstreamPool,
  buildChildEnv,
  credentialKey,
  poolCeilingForMemory,
  poolOptionsFromEnv,
  resolveUpstreamBin,
  CHILD_PEAK_MB,
  CHILD_STARTUP_MB,
  MEMORY_MARGIN,
  WRAPPER_PEAK_MB,
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

  it("changes when any single one of baseUrl, clientId or clientSecret changes", () => {
    const k = credentialKey(A);
    expect(credentialKey({ ...A, baseUrl: "https://eu2-cloud.acronis.com" })).not.toBe(k);
    expect(credentialKey({ ...A, clientId: "a2" })).not.toBe(k);
    expect(credentialKey({ ...A, clientSecret: "sa-secret2" })).not.toBe(k);
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
    const pool = new UpstreamPool({ toolsInclude: ["fetch_tenant"], spawner, memoryLimitBytes: 2 ** 30 });
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
    const pool = new UpstreamPool({ toolsInclude: [], spawner, max: 2, memoryLimitBytes: 2 ** 30 });
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
    const secondA = use(pool, A); // queued on the existing A child (one call at a time), not a second A child
    await new Promise((r) => setTimeout(r, 10));
    expect(spawned).toHaveLength(1);
    release();
    await held;
    await secondA;
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
    const MiB = 1024 * 1024;

    it("derives the ceiling from the container's memory: 1 child at 0.5 Gi, 4 at 1 Gi, never above MAX_POOL_MAX, never below 1", () => {
      expect(poolCeilingForMemory(512 * MiB)).toBe(1);
      expect(poolCeilingForMemory(768 * MiB)).toBe(3);
      expect(poolCeilingForMemory(1024 * MiB)).toBe(4);
      expect(poolCeilingForMemory(64 * 1024 * MiB)).toBe(MAX_POOL_MAX);
      expect(poolCeilingForMemory(200 * MiB)).toBe(1);
    });

    it("keeps the wrapper at its peak, every child at its peak, one replacement and the margin inside the limit", () => {
      for (const mb of [512, 640, 768, 1024, 2048]) {
        const n = poolCeilingForMemory(mb * MiB);
        const peak = WRAPPER_PEAK_MB + n * CHILD_PEAK_MB + CHILD_STARTUP_MB;
        expect(peak * (1 + MEMORY_MARGIN)).toBeLessThanOrEqual(mb);
        if (n < MAX_POOL_MAX) expect((peak + CHILD_PEAK_MB) * (1 + MEMORY_MARGIN)).toBeGreaterThan(mb); // and no smaller than it can be
      }
    });

    it("falls back to the conservative 512 MiB ceiling when the limit is unknown or unlimited", () => {
      expect(poolCeilingForMemory(0)).toBe(1); // Node reports 0 when it cannot tell
      expect(poolCeilingForMemory(2 ** 60)).toBe(1); // cgroup "no limit" is a huge number
      expect(poolCeilingForMemory(Number.NaN)).toBe(1);
    });

    it("uses that ceiling as the default size, and ACRONIS_POOL_MAX can only lower it", async () => {
      expect(poolOptionsFromEnv({}).max).toBeUndefined();
      const { spawner, spawned } = fakeSpawner();
      const pool = new UpstreamPool({ toolsInclude: [], spawner, memoryLimitBytes: 512 * MiB, waitMs: 5 });
      const held = pool.withConnection(A, () => new Promise<void>(() => undefined));
      await new Promise((r) => setTimeout(r, 10));
      expect(spawned).toHaveLength(1);
      await expect(use(pool, B)).rejects.toBeInstanceOf(PoolBusyError); // a second would not fit 0.5 Gi
      expect(spawned).toHaveLength(1);
      void held;
      await pool.close();
    });

    it("clamps max to the ceiling and never spawns beyond it", async () => {
      const { spawner, spawned } = fakeSpawner();
      const pool = new UpstreamPool({ toolsInclude: [], spawner, max: 1_000, memoryLimitBytes: 64 * 1024 * MiB, waitMs: 5 });
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

  describe("calls per child", () => {
    const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

    it(`runs at most ${MAX_CALLS_PER_CHILD} calls at once in one child; the rest wait for a slot`, async () => {
      const { spawner, spawned } = fakeSpawner();
      const pool = new UpstreamPool({ toolsInclude: [], spawner });
      let running = 0;
      let peak = 0;
      const gates: Array<() => void> = [];
      const calls = Array.from({ length: 6 }, () =>
        pool.withConnection(A, async () => {
          running++;
          peak = Math.max(peak, running);
          await new Promise<void>((r) => gates.push(r));
          running--;
        })
      );
      await tick();
      expect(running).toBe(MAX_CALLS_PER_CHILD);
      for (let i = 0; i < calls.length; i++) {
        await vi.waitFor(() => expect(gates.length).toBeGreaterThan(i));
        gates[i]();
      }
      await Promise.all(calls);
      expect(peak).toBe(MAX_CALLS_PER_CHILD);
      expect(spawned).toHaveLength(1);
      await pool.close();
    });

    it("refuses at once when a child's call queue is full, and a caller that disconnects frees its place", async () => {
      const { spawner } = fakeSpawner();
      const pool = new UpstreamPool({ toolsInclude: [], spawner, maxQueue: 1, waitMs: 60_000 });
      const releases: Array<() => void> = [];
      const holds = Array.from({ length: MAX_CALLS_PER_CHILD }, () =>
        pool.withConnection(A, () => new Promise<void>((r) => releases.push(r)))
      );
      await tick();
      const gone = new AbortController();
      const queued = pool.withConnection(A, async () => "queued", gone.signal);
      await tick();
      await expect(pool.withConnection(A, async () => "x")).rejects.toBeInstanceOf(PoolBusyError); // 1/1 taken
      gone.abort();
      await expect(queued).rejects.toThrow();
      const next = pool.withConnection(A, async () => "next"); // the place is free again
      releases.forEach((r) => r());
      await Promise.all(holds);
      await expect(next).resolves.toBe("next");
      await pool.close();
    });
  });

  describe("pool queue and replacement", () => {
    const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

    it("releases a waiting caller's queue place when that caller disconnects", async () => {
      const { spawner, spawned } = fakeSpawner();
      const pool = new UpstreamPool({ toolsInclude: [], spawner, max: 1, maxQueue: 1, waitMs: 60_000 });
      let release!: () => void;
      const held = pool.withConnection(A, () => new Promise<void>((r) => (release = r)));
      await tick(0);
      const gone = new AbortController();
      const waitingB = pool.withConnection(B, async () => "b", gone.signal);
      await tick();
      await expect(use(pool, C)).rejects.toBeInstanceOf(PoolBusyError); // queue 1/1 is full
      gone.abort();
      await expect(waitingB).rejects.toThrow();
      const waitingD = pool.withConnection({ ...C, clientId: "d" }, async () => "d"); // the place is free again
      await tick();
      release();
      await held;
      await expect(waitingD).resolves.toBe("d");
      expect(spawned.some((s) => s.creds.clientId === "b")).toBe(false); // B never spawned
      await pool.close();
    });

    it("evicts an idle child only after its replacement has started, so failing spawns cannot flush healthy tenants", async () => {
      const closed: string[] = [];
      const spawner: Spawner = async (creds) => {
        if (creds.clientId.startsWith("bad")) throw new Error("invalid_client");
        return { callTool: async () => ({}), listToolNames: async () => [], close: async () => void closed.push(creds.clientId) };
      };
      const pool = new UpstreamPool({ toolsInclude: [], spawner, max: 1 });
      await use(pool, A); // a healthy tenant, now idle in a full pool
      for (let i = 0; i < 5; i++) await use(pool, { ...B, clientId: `bad${i}` }).catch(() => undefined);
      await tick();
      expect(pool.keys()).toEqual([credentialKey(A)]);
      expect(closed).toEqual([]);
      await use(pool, B); // a replacement that starts does evict it
      await tick();
      expect(pool.keys()).toEqual([credentialKey(B)]);
      expect(closed).toEqual(["a"]);
      await pool.close();
    });

    it("keeps the old child while its replacement is starting, and starts at most one replacement at a time", async () => {
      let started!: () => void;
      const gate = new Promise<void>((r) => (started = r));
      const spawnedFor: string[] = [];
      const closed: string[] = [];
      const spawner: Spawner = async (creds) => {
        spawnedFor.push(creds.clientId);
        if (creds.clientId === "b") await gate;
        return { callTool: async () => ({}), listToolNames: async () => [], close: async () => void closed.push(creds.clientId) };
      };
      const pool = new UpstreamPool({ toolsInclude: [], spawner, max: 1 });
      await use(pool, A);
      const b = use(pool, B);
      await tick();
      expect(closed).toEqual([]); // A still serves while B starts
      expect(pool.size).toBe(2); // briefly one over max
      const c = use(pool, C);
      await tick();
      expect(spawnedFor).toEqual(["a", "b"]); // C waits: no second extra child
      started();
      await b;
      await c;
      expect(spawnedFor).toEqual(["a", "b", "a"]); // C (clientId "a", other baseUrl) replaced B once B was done
      expect(pool.size).toBe(1);
      await pool.close();
    });
  });

  describe("eviction during churn", () => {
    const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

    /** A spawner that counts live children and lets the test hold one tenant's spawn open. */
    function countingSpawner(slow: string) {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const stats = { live: 0, peakLive: 0, closed: [] as string[] };
      const spawner: Spawner = async (creds) => {
        stats.live++;
        stats.peakLive = Math.max(stats.peakLive, stats.live);
        if (creds.clientId === slow) await gate;
        return {
          callTool: async () => ({}),
          listToolNames: async () => [],
          close: async () => {
            stats.live--;
            stats.closed.push(creds.clientId);
          },
        };
      };
      return { spawner, stats, release: () => release() };
    }

    it("picks the victim again when the replacement is up: a tenant that called in meanwhile is not retired while running", async () => {
      const { spawner, stats, release } = countingSpawner("b");
      const pool = new UpstreamPool({ toolsInclude: [], spawner, max: 2, memoryLimitBytes: 2 ** 30 });
      await use(pool, A); // A and C idle, A the older
      await use(pool, { ...A, clientId: "c" });
      const b = use(pool, B); // B starts; A is the chosen victim
      await tick();
      let releaseA!: () => void;
      const aBusy = pool.withConnection(A, () => new Promise<void>((r) => (releaseA = r))); // A calls in while B starts
      await tick();
      release();
      await b;
      await tick();
      expect(stats.closed).toEqual(["c"]); // C, the idle one, went; A kept running
      expect(pool.size).toBe(2);
      expect(stats.live).toBe(2);
      releaseA();
      await aBusy;
      await pool.close();
    });

    it("refuses the newcomer, and closes its child, when nothing is idle by the time it is up", async () => {
      const { spawner, stats, release } = countingSpawner("b");
      const pool = new UpstreamPool({ toolsInclude: [], spawner, max: 1 });
      await use(pool, A);
      const b = use(pool, B).catch((e: unknown) => e);
      await tick();
      let releaseA!: () => void;
      const aBusy = pool.withConnection(A, () => new Promise<void>((r) => (releaseA = r)));
      await tick();
      release();
      expect(await b).toBeInstanceOf(PoolBusyError);
      await tick();
      expect(stats.closed).toEqual(["b"]); // the newcomer's child, not the running one
      expect(stats.live).toBe(1);
      expect(pool.keys()).toEqual([credentialKey(A)]);
      // The refusal says nothing about B's credential, so B may try again once A is idle.
      releaseA();
      await aBusy;
      await use(pool, B);
      expect(pool.keys()).toEqual([credentialKey(B)]);
      await pool.close();
    });

    it("never has more live children than max plus the one replacement, however the tenants churn", async () => {
      const { spawner, stats } = countingSpawner("never");
      const max = 2;
      const pool = new UpstreamPool({ toolsInclude: [], spawner, max, memoryLimitBytes: 2 ** 30, waitMs: 2_000 });
      const tenants = Array.from({ length: 6 }, (_, i) => ({ ...A, clientId: `t${i}` }));
      await Promise.all(
        Array.from({ length: 8 }, async (_, caller) => {
          for (let round = 0; round < 15; round++) {
            const t = tenants[(caller + round * 3) % tenants.length]!;
            await pool.withConnection(t, () => tick(1)).catch((e: unknown) => {
              if (!(e instanceof PoolBusyError)) throw e;
            });
          }
        })
      );
      expect(stats.peakLive).toBeLessThanOrEqual(max + 1);
      await pool.close();
      expect(stats.live).toBe(0);
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
  it("leaves max to the memory ceiling and defaults idle to 10 minutes; honours overrides", () => {
    expect(poolOptionsFromEnv({})).toEqual({ max: undefined, idleMs: 600_000 });
    expect(poolOptionsFromEnv({ ACRONIS_POOL_MAX: "5", ACRONIS_POOL_IDLE_MS: "1000" })).toEqual({ max: 5, idleMs: 1000 });
    expect(poolOptionsFromEnv({ ACRONIS_POOL_MAX: "abc", ACRONIS_POOL_IDLE_MS: "-3" })).toEqual({ max: undefined, idleMs: 600_000 });
  });

  it("takes the container memory from ACRONIS_MEMORY_LIMIT_MB when the runtime cannot report it", () => {
    expect(poolOptionsFromEnv({ ACRONIS_MEMORY_LIMIT_MB: "1024" }).memoryLimitBytes).toBe(1024 * 1024 * 1024);
    expect(poolOptionsFromEnv({ ACRONIS_MEMORY_LIMIT_MB: "0" }).memoryLimitBytes).toBeUndefined();
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
