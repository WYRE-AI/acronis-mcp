import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_CALLS_PER_CHILD,
  MAX_FAILED_SPAWNS,
  MAX_POOL_MAX,
  MAX_WAITERS_PER_CREDENTIAL,
  PoolBusyError,
  REPLACEMENT_SPAWN_TIMEOUT_MS,
  SPAWN_TIMEOUT_MS,
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
import { logger } from "../utils/logger.js";

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
    const pool = new UpstreamPool({ toolsInclude: ["fetch_tenant"], spawner, sliceMs: 0, memoryLimitBytes: 2 ** 30 });
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
    const pool = new UpstreamPool({ toolsInclude: [], spawner, sliceMs: 0 });
    await Promise.all([use(pool, A), use(pool, A), use(pool, A)]);
    expect(spawned).toHaveLength(1);
    await pool.close();
  });

  it("routes each tenant's call to its own child", async () => {
    const { spawner } = fakeSpawner();
    const pool = new UpstreamPool({ toolsInclude: [], spawner, sliceMs: 0 });
    const ra = await pool.withConnection(A, (c) => c.callTool("t", {}));
    const rb = await pool.withConnection(B, (c) => c.callTool("t", {}));
    expect(JSON.stringify(ra)).toContain("t:a");
    expect(JSON.stringify(rb)).toContain("t:b");
    await pool.close();
  });

  it("evicts the least-recently-used entry beyond max and closes it", async () => {
    const { spawner, spawned } = fakeSpawner();
    const pool = new UpstreamPool({ toolsInclude: [], spawner, sliceMs: 0, max: 2, memoryLimitBytes: 2 ** 30 });
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
    const pool = new UpstreamPool({ toolsInclude: [], spawner, sliceMs: 0, idleMs: 600_000, now: () => now });
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
    const pool = new UpstreamPool({ toolsInclude: [], spawner, sliceMs: 0, max: 1 });
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
    vi.useFakeTimers(); // A is younger than a slice when it is released, whatever the machine's load
    const { spawner, spawned } = fakeSpawner();
    const pool = new UpstreamPool({ toolsInclude: [], spawner, sliceMs: 10_000, max: 1, waitMs: 60_000 });
    let release!: () => void;
    const held = pool.withConnection(A, () => new Promise<void>((r) => (release = r)));
    await vi.advanceTimersByTimeAsync(0);
    const waitingB = use(pool, B);
    const secondA = use(pool, A); // queued on the existing A child (one call at a time), not a second A child
    await vi.advanceTimersByTimeAsync(10);
    expect(spawned).toHaveLength(1);
    release();
    await held;
    await secondA;
    await vi.advanceTimersByTimeAsync(11_000); // A has aged, so B may replace it
    await waitingB;
    expect(spawned).toHaveLength(2);
    expect(spawned.filter((s) => s.creds.clientId === "a")).toHaveLength(1);
    await pool.close();
  });

  it("fails with PoolBusyError when no slot frees up within waitMs", async () => {
    const { spawner, spawned } = fakeSpawner();
    const pool = new UpstreamPool({ toolsInclude: [], spawner, sliceMs: 0, max: 1, waitMs: 20 });
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
    const pool = new UpstreamPool({ toolsInclude: [], spawner, sliceMs: 0 });
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
    const pool = new UpstreamPool({ toolsInclude: [], spawner, sliceMs: 0 });
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
      const pool = new UpstreamPool({ toolsInclude: [], spawner, sliceMs: 0 });
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
      const pool = new UpstreamPool({ toolsInclude: [], spawner, sliceMs: 0 });
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
      const pool = new UpstreamPool({ toolsInclude: [], spawner, sliceMs: 0, failedSpawnTtlMs: 30_000, now: () => now });
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
      const pool = new UpstreamPool({ toolsInclude: [], spawner, sliceMs: 0 });
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

    it("derives the ceiling from the container's memory: 1 child at 0.5 Gi, 2 at 0.75 Gi, 4 at 1 Gi, never above MAX_POOL_MAX, never below 1", () => {
      expect(poolCeilingForMemory(512 * MiB)).toBe(1);
      expect(poolCeilingForMemory(768 * MiB)).toBe(2);
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
      const pool = new UpstreamPool({ toolsInclude: [], spawner, sliceMs: 0, memoryLimitBytes: 512 * MiB, waitMs: 5 });
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
      const pool = new UpstreamPool({ toolsInclude: [], spawner, sliceMs: 0, max: 1_000, memoryLimitBytes: 64 * 1024 * MiB, waitMs: 5 });
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
      const pool = new UpstreamPool({ toolsInclude: [], spawner, sliceMs: 0, max: 1, maxQueue: 2, waitMs: 60_000 });
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
      const pool = new UpstreamPool({ toolsInclude: [], spawner, sliceMs: 0 });
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
      const pool = new UpstreamPool({ toolsInclude: [], spawner, sliceMs: 0, maxQueue: 1, waitMs: 60_000 });
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
      const pool = new UpstreamPool({ toolsInclude: [], spawner, sliceMs: 0, max: 1, maxQueue: 1, waitMs: 60_000 });
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
      const pool = new UpstreamPool({ toolsInclude: [], spawner, sliceMs: 0, max: 1 });
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
      const pool = new UpstreamPool({ toolsInclude: [], spawner, sliceMs: 0, max: 1 });
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

    it("the child being replaced takes no new calls: its tenant waits behind the newcomer, so the newcomer is served, never refused", async () => {
      const { spawner, stats, release } = countingSpawner("b");
      const pool = new UpstreamPool({ toolsInclude: [], spawner, sliceMs: 0, max: 1, waitMs: 60_000 });
      await use(pool, A);
      const b = use(pool, B); // replaces A; B's spawn is held open
      await tick();
      const ran: string[] = [];
      const aAgain = pool.withConnection(A, async () => void ran.push("a")); // A calls in while it is being replaced
      await tick();
      expect(ran).toEqual([]); // not served by the child that is about to close
      expect(stats.live).toBe(2); // A still up, B starting: max + 1
      release();
      await b; // the newcomer is served
      await aAgain; // and A is served after it, in a child of its own
      expect(ran).toEqual(["a"]);
      expect(stats.closed).toEqual(["a", "b"]); // each replaced the other, in turn
      expect(stats.peakLive).toBeLessThanOrEqual(2);
      await pool.close();
    });

    it("leaves the victim alone when it has already gone by the time the newcomer is up", async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let aExits!: () => void;
      const closed: string[] = [];
      const spawner: Spawner = async (creds, _include, ctx) => {
        if (creds.clientId === "a") aExits = ctx.onClose;
        if (creds.clientId === "b") await gate;
        return { callTool: async () => ({}), listToolNames: async () => [], close: async () => void closed.push(creds.clientId) };
      };
      const pool = new UpstreamPool({ toolsInclude: [], spawner, sliceMs: 0, max: 1 });
      await use(pool, A);
      const b = use(pool, B);
      await tick();
      aExits(); // A's child exits on its own while B starts
      release();
      await b;
      await tick();
      expect(pool.keys()).toEqual([credentialKey(B)]);
      expect(closed).toEqual(["a"]); // closed once, by the exit, and not again
      await pool.close();
    });

    it("never has more live children than max plus the one replacement, however the tenants churn", async () => {
      const { spawner, stats } = countingSpawner("never");
      const max = 2;
      const pool = new UpstreamPool({ toolsInclude: [], spawner, sliceMs: 0, max, memoryLimitBytes: 2 ** 30, waitMs: 2_000 });
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

  describe("slow-closing children", () => {
    const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

    /** Counts live children from the start of a spawn to the END of its close, with a spawn and a close that each take time. */
    function slowSpawner(spawnMs: number, closeMs: number, closeForever = false) {
      const stats = { live: 0, peakLive: 0, spawned: 0 };
      const spawner: Spawner = async () => {
        stats.live++;
        stats.spawned++;
        stats.peakLive = Math.max(stats.peakLive, stats.live);
        await tick(spawnMs);
        return {
          callTool: async () => ({}),
          listToolNames: async () => [],
          close: async () => {
            if (closeForever) return new Promise<void>(() => undefined);
            await tick(closeMs);
            stats.live--;
          },
        };
      };
      return { spawner, stats };
    }

    it("a burst of 30 distinct newcomers at max 2 never has more than max + 1 live children (40 ms close, 30 ms spawn)", async () => {
      const { spawner, stats } = slowSpawner(30, 40);
      const max = 2;
      const pool = new UpstreamPool({ toolsInclude: [], spawner, sliceMs: 0, max, memoryLimitBytes: 2 ** 30, waitMs: 60_000, maxQueue: 64 });
      const tenants = Array.from({ length: 30 }, (_, i) => ({ ...A, clientId: `burst${i}` }));
      await Promise.all(tenants.map((t) => pool.withConnection(t, () => tick(1))));
      expect(stats.spawned).toBe(30);
      expect(stats.peakLive).toBeLessThanOrEqual(max + 1);
      await pool.close();
      expect(stats.live).toBe(0);
    }, 30_000);

    it("does not start the next replacement until the evicted child has exited", async () => {
      const { spawner, stats } = slowSpawner(5, 200);
      const pool = new UpstreamPool({ toolsInclude: [], spawner, sliceMs: 0, max: 1, waitMs: 60_000 });
      await use(pool, A);
      const b = use(pool, B); // replaces A: A takes 200 ms to exit
      await tick(50);
      const c = use(pool, C); // must wait for A to be gone, not start another child beside A and B
      await tick(50);
      expect(stats.spawned).toBe(2); // A and B; C has not started
      expect(stats.live).toBe(2); // A still closing, B up
      await Promise.all([b, c]);
      expect(stats.peakLive).toBeLessThanOrEqual(2);
      await pool.close();
    });

    it("stops waiting for a close that never returns, so one stuck child cannot block every later replacement", async () => {
      const { spawner, stats } = slowSpawner(5, 0, true);
      const pool = new UpstreamPool({ toolsInclude: [], spawner, sliceMs: 0, max: 1, closeTimeoutMs: 50, waitMs: 60_000 });
      await use(pool, A);
      const started = Date.now();
      await use(pool, B); // A's close never returns
      await use(pool, C); // and C still gets through, after B's replacement ended at the timeout
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(stats.spawned).toBe(3);
      await pool.close();
    });
  });

  describe("fairness between tenants", () => {
    const SLICE = 10_000;
    const CALL_MS = 100;
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    /** A fake spawner that records which tenant each child was started for, in order. */
    function recordingSpawner() {
      const started: string[] = [];
      const spawner: Spawner = async (creds) => {
        started.push(creds.clientId);
        return { callTool: async () => ({}), listToolNames: async () => [], close: async () => undefined };
      };
      return { spawner, started };
    }

    interface Tally {
      ok: number;
      busy: number;
      firstOkAt?: number;
      worstMs: number;
    }

    /** `callers` loops calling back to back (each call CALL_MS long) until `until`; results tallied. */
    function hammer(pool: UpstreamPool, tenant: AcronisCredentials, callers: number, until: number): Tally {
      const tally: Tally = { ok: 0, busy: 0, worstMs: 0 };
      for (let i = 0; i < callers; i++) {
        void (async () => {
          while (Date.now() < until) {
            const began = Date.now();
            try {
              await pool.withConnection(tenant, () => sleep(CALL_MS));
              tally.ok++;
              tally.firstOkAt ??= Date.now();
              tally.worstMs = Math.max(tally.worstMs, Date.now() - began);
            } catch (e) {
              if (!(e instanceof PoolBusyError)) throw e;
              tally.busy++;
            }
          }
        })();
      }
      return tally;
    }

    it("a tenant with a steady stream of calls cannot keep another out: both are served, taking turns (the reviewer's repro: 2 tenants x 3 callers, ceiling 1, 45 s)", async () => {
      vi.useFakeTimers();
      const { spawner, started } = recordingSpawner();
      const pool = new UpstreamPool({ toolsInclude: [], spawner, max: 1, sliceMs: SLICE, waitMs: 30_000 });
      const t0 = Date.now();
      const end = t0 + 45_000;
      const a = hammer(pool, A, 3, end);
      await vi.advanceTimersByTimeAsync(1_000);
      const bFrom = Date.now();
      const b = hammer(pool, B, 3, end);
      await vi.advanceTimersByTimeAsync(44_000 + 2_000 + SLICE); // past the end by a slice, so callers still waiting for a turn are served too
      // B is served within about one time slice plus one call of A having the slot, not never.
      expect(b.firstOkAt).toBeDefined();
      expect(b.firstOkAt! - bFrom).toBeLessThanOrEqual(SLICE + 3 * CALL_MS + CALL_MS);
      // Neither is refused, and each makes real progress (before the fix: A 868 calls, B 3 and a 30 s wait).
      expect(a.busy).toBe(0);
      expect(b.busy).toBe(0);
      expect(a.ok).toBeGreaterThan(100);
      expect(b.ok).toBeGreaterThan(100);
      // Nobody waits much longer than the other's slice (plus a start and the calls in flight).
      expect(a.worstMs).toBeLessThanOrEqual(SLICE + 1_500);
      expect(b.worstMs).toBeLessThanOrEqual(SLICE + 1_500);
      // They alternate: a child per turn, A, B, A, B, ...
      expect(started.length).toBeGreaterThanOrEqual(4);
      started.forEach((id, i) => expect(id).toBe(i % 2 === 0 ? "a" : "b"));
      await pool.close();
    });

    it("keeps the fast path when nobody waits: a lone tenant is never asked to make way, however long it runs", async () => {
      vi.useFakeTimers();
      const { spawner, started } = recordingSpawner();
      const pool = new UpstreamPool({ toolsInclude: [], spawner, max: 1, sliceMs: SLICE });
      const a = hammer(pool, A, 3, Date.now() + 60_000);
      await vi.advanceTimersByTimeAsync(62_000);
      expect(started).toEqual(["a"]); // one child, six slices long, never respawned
      expect(a.busy).toBe(0);
      expect(a.ok).toBeGreaterThan(550); // one call at a time, 10 a second
      await pool.close();
    });

    it("never interrupts a call: a call still running when its slice ends finishes, and the waiter starts after it", async () => {
      vi.useFakeTimers();
      const { spawner, started } = recordingSpawner();
      const pool = new UpstreamPool({ toolsInclude: [], spawner, max: 1, sliceMs: SLICE, waitMs: 60_000 });
      const log: string[] = [];
      const long = pool.withConnection(A, async () => {
        await sleep(SLICE + 5_000); // runs past its own slice
        log.push("a call done");
      });
      await vi.advanceTimersByTimeAsync(500);
      const b = pool.withConnection(B, async () => log.push("b call"));
      await vi.advanceTimersByTimeAsync(SLICE + 10_000);
      await Promise.all([long, b]);
      expect(log).toEqual(["a call done", "b call"]);
      expect(started).toEqual(["a", "b"]);
      await pool.close();
    });

    it("hands the slot to the waiters in the order they arrived", async () => {
      const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
      const { spawner, started } = recordingSpawner();
      const pool = new UpstreamPool({ toolsInclude: [], spawner, max: 1, sliceMs: 100, waitMs: 60_000 }); // short, so each child has aged by its turn
      let release!: () => void;
      const held = pool.withConnection(A, () => new Promise<void>((r) => (release = r)));
      await tick(0);
      const served: string[] = [];
      const waiting: Array<Promise<void>> = [];
      for (const id of ["b", "c", "d", "e"]) {
        waiting.push(pool.withConnection({ ...A, clientId: id }, async () => void served.push(id)));
        await tick(5); // arrive one after the other
      }
      await tick(20);
      release();
      await held;
      await Promise.all(waiting);
      expect(started).toEqual(["a", "b", "c", "d", "e"]);
      expect(served).toEqual(["b", "c", "d", "e"]);
      await pool.close();
    });

    it("with room for two children, a third tenant gets in once either of them has had its slice", async () => {
      vi.useFakeTimers();
      const { spawner, started } = recordingSpawner();
      const pool = new UpstreamPool({ toolsInclude: [], spawner, max: 2, memoryLimitBytes: 2 ** 30, sliceMs: SLICE, waitMs: 30_000 });
      const end = Date.now() + 30_000;
      const a = hammer(pool, A, 2, end);
      const b = hammer(pool, B, 2, end);
      await vi.advanceTimersByTimeAsync(500);
      const cFrom = Date.now();
      const c = hammer(pool, { ...A, clientId: "c" }, 2, end);
      await vi.advanceTimersByTimeAsync(32_000);
      expect(c.firstOkAt! - cFrom).toBeLessThanOrEqual(SLICE + 1_000);
      expect([a.busy, b.busy, c.busy]).toEqual([0, 0, 0]);
      expect(Math.min(a.ok, b.ok, c.ok)).toBeGreaterThan(50);
      expect(started.slice(0, 3)).toEqual(["a", "b", "c"]);
      await pool.close();
    });
  });

  describe("churn, replacement spawns and queue limits", () => {
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const ids = (spawned: Array<{ creds: AcronisCredentials }>) => spawned.map((s) => s.creds.clientId);

    it("an idle child is not replaced until it has been up for a time slice", async () => {
      vi.useFakeTimers();
      const { spawner, spawned } = fakeSpawner();
      const pool = new UpstreamPool({ toolsInclude: [], spawner, max: 1, sliceMs: 10_000, waitMs: 60_000 });
      await use(pool, A); // A is idle at once
      let bDone = false;
      void use(pool, B).then(() => (bDone = true));
      await vi.advanceTimersByTimeAsync(9_000);
      expect(ids(spawned)).toEqual(["a"]); // B waits; the idle A is too young to replace
      expect(bDone).toBe(false);
      await vi.advanceTimersByTimeAsync(1_500); // A has now been up for a slice, with nothing else waking B
      expect(ids(spawned)).toEqual(["a", "b"]);
      expect(bDone).toBe(true);
      expect(spawned[0].closed).toBe(true);
      await pool.close();
    });

    it("two tenants that pause between calls respawn a slot at most once per slice (500 ms think time, ceiling 1, 60 s)", async () => {
      vi.useFakeTimers();
      const { spawner, spawned } = fakeSpawner();
      const pool = new UpstreamPool({ toolsInclude: [], spawner, max: 1, sliceMs: 10_000, waitMs: 30_000 });
      const end = Date.now() + 60_000;
      for (const tenant of [A, B]) {
        for (let i = 0; i < 3; i++) {
          void (async () => {
            while (Date.now() < end) {
              await pool.withConnection(tenant, () => sleep(100)).catch((e: unknown) => {
                if (!(e instanceof PoolBusyError)) throw e;
              });
              await sleep(500);
            }
          })();
        }
      }
      await vi.advanceTimersByTimeAsync(62_000);
      expect(spawned.length).toBeGreaterThanOrEqual(4); // both tenants are served, in turns
      expect(spawned.length).toBeLessThanOrEqual(60_000 / 10_000 + 2); // before: a spawn whenever the child was idle between two calls
      await pool.close();
    });

    it("a replacement spawn is given the short timeout; a spawn into free room keeps the spawner's own", async () => {
      const seen: Array<number | undefined> = [];
      const spawner: Spawner = async (_creds, _include, ctx) => {
        seen.push(ctx.spawnTimeoutMs);
        return { callTool: async () => ({}), listToolNames: async () => [], close: async () => undefined };
      };
      const pool = new UpstreamPool({ toolsInclude: [], spawner, sliceMs: 0, max: 1 });
      await use(pool, A);
      await use(pool, B); // replaces A
      expect(seen).toEqual([undefined, REPLACEMENT_SPAWN_TIMEOUT_MS]);
      expect(REPLACEMENT_SPAWN_TIMEOUT_MS).toBeLessThan(SPAWN_TIMEOUT_MS);
      await pool.close();
    });

    it("one tenant's parallel callers cannot fill the wait queue: its extra callers are refused at once and another tenant still queues", async () => {
      const { spawner } = fakeSpawner();
      const pool = new UpstreamPool({ toolsInclude: [], spawner, sliceMs: 0, max: 1, waitMs: 60_000 });
      let release!: () => void;
      const held = pool.withConnection(A, () => new Promise<void>((r) => (release = r)));
      await sleep(5);
      const queued = Array.from({ length: MAX_WAITERS_PER_CREDENTIAL }, () => use(pool, B)); // B fills its own share
      await sleep(5);
      await expect(use(pool, B)).rejects.toBeInstanceOf(PoolBusyError); // one more is refused at once
      const c = use(pool, C); // another tenant is not refused
      await sleep(5);
      release();
      await held;
      await Promise.all([...queued, c]);
      await pool.close();
    });

    it("logs the memory limit, the ceiling and the slice once at construction, and says when the limit is unknown", () => {
      const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
      new UpstreamPool({ toolsInclude: [], memoryLimitBytes: 1024 * 1024 * 1024, sliceMs: 5_000 });
      expect(info).toHaveBeenCalledWith("Upstream pool", { memoryLimitMb: 1024, ceiling: 4, max: 4, sliceMs: 5_000 });
      vi.spyOn(process, "constrainedMemory").mockReturnValue(0);
      new UpstreamPool({ toolsInclude: [] });
      expect(info).toHaveBeenLastCalledWith("Upstream pool", { memoryLimitMb: "unknown (assuming 512)", ceiling: 1, max: 1, sliceMs: 10_000 });
    });
  });

  it("close() closes every child and refuses further use", async () => {
    const { spawner, spawned } = fakeSpawner();
    const pool = new UpstreamPool({ toolsInclude: [], spawner, sliceMs: 0 });
    await use(pool, A);
    await use(pool, B);
    await pool.close();
    expect(spawned.every((s) => s.closed)).toBe(true);
    expect(pool.size).toBe(0);
    await expect(use(pool, A)).rejects.toThrow(/closed/);
  });
});

describe("poolOptionsFromEnv", () => {
  const MiB = 1024 * 1024;

  it("leaves max to the memory ceiling, defaults idle to 10 minutes and the time slice to 10 s; honours overrides", () => {
    expect(poolOptionsFromEnv({}, 0)).toEqual({ max: undefined, idleMs: 600_000, sliceMs: 10_000 });
    expect(poolOptionsFromEnv({ ACRONIS_POOL_MAX: "5", ACRONIS_POOL_IDLE_MS: "1000", ACRONIS_POOL_SLICE_MS: "2000" }, 0)).toEqual({
      max: 5,
      idleMs: 1000,
      sliceMs: 2000,
    });
    expect(poolOptionsFromEnv({ ACRONIS_POOL_MAX: "abc", ACRONIS_POOL_IDLE_MS: "-3", ACRONIS_POOL_SLICE_MS: "x" }, 0)).toEqual({
      max: undefined,
      idleMs: 600_000,
      sliceMs: 10_000,
    });
  });

  it("clamps the time slice to between 1 s and half the wait: 1 would be a respawn per call, a huge value brings starvation back", () => {
    expect(poolOptionsFromEnv({ ACRONIS_POOL_SLICE_MS: "1" }, 0).sliceMs).toBe(1_000);
    expect(poolOptionsFromEnv({ ACRONIS_POOL_SLICE_MS: "999" }, 0).sliceMs).toBe(1_000);
    expect(poolOptionsFromEnv({ ACRONIS_POOL_SLICE_MS: "99999999999" }, 0).sliceMs).toBe(15_000);
    expect(poolOptionsFromEnv({ ACRONIS_POOL_SLICE_MS: "5000" }, 0).sliceMs).toBe(5_000);
    for (const bad of ["0", "-1", "NaN", "abc", ""]) expect(poolOptionsFromEnv({ ACRONIS_POOL_SLICE_MS: bad }, 0).sliceMs).toBe(10_000);
  });

  describe("ACRONIS_MEMORY_LIMIT_MB can only lower the memory the pool sizes itself for", () => {
    it("is capped at the container's limit when Node can read it: 4096 in a 0.5 Gi container is 0.5 Gi", () => {
      const o = poolOptionsFromEnv({ ACRONIS_MEMORY_LIMIT_MB: "4096" }, 512 * MiB);
      expect(o.memoryLimitBytes).toBe(512 * MiB);
      expect(poolCeilingForMemory(o.memoryLimitBytes)).toBe(1); // not 4
    });

    it("lowers the limit when it is below the container's", () => {
      const o = poolOptionsFromEnv({ ACRONIS_MEMORY_LIMIT_MB: "512" }, 1024 * MiB);
      expect(o.memoryLimitBytes).toBe(512 * MiB);
      expect(poolCeilingForMemory(o.memoryLimitBytes)).toBe(1);
    });

    it("leaves the container's own limit alone when unset", () => {
      expect(poolOptionsFromEnv({}, 1024 * MiB).memoryLimitBytes).toBeUndefined(); // the pool reads the same limit itself
    });

    it("is ignored when Node cannot read a limit (unknown, 0 or the cgroup 'no limit'): the pool keeps its 1 child", () => {
      for (const unreadable of [undefined, 0, 2 ** 60, Number.NaN]) {
        const o = poolOptionsFromEnv({ ACRONIS_MEMORY_LIMIT_MB: "4096" }, unreadable);
        expect(o.memoryLimitBytes).toBeUndefined();
        expect(poolCeilingForMemory(o.memoryLimitBytes ?? unreadable)).toBe(1);
      }
    });

    it("ignores a value that is not a positive number", () => {
      expect(poolOptionsFromEnv({ ACRONIS_MEMORY_LIMIT_MB: "0" }, 1024 * MiB).memoryLimitBytes).toBeUndefined();
      expect(poolOptionsFromEnv({ ACRONIS_MEMORY_LIMIT_MB: "lots" }, 1024 * MiB).memoryLimitBytes).toBeUndefined();
    });

    it("sizes a real pool from the capped value, never from the raw one", async () => {
      const { spawner } = fakeSpawner();
      const o = poolOptionsFromEnv({ ACRONIS_MEMORY_LIMIT_MB: "4096" }, 512 * MiB);
      const pool = new UpstreamPool({ toolsInclude: [], spawner, ...o, waitMs: 5 });
      const releases: Array<() => void> = [];
      const held = [A, B].map((c) => pool.withConnection(c, () => new Promise<void>((r) => releases.push(r))).catch((e: unknown) => e));
      await new Promise((r) => setTimeout(r, 20));
      expect(releases).toHaveLength(1); // one child at 0.5 Gi, the second tenant is refused
      expect((await held[1]) instanceof PoolBusyError).toBe(true);
      releases[0]!();
      await held[0];
      await pool.close();
    });
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
