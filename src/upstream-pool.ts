import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
/**
 * Pool of upstream MCP child processes — ONE child per distinct credential
 * tuple, never shared across tenants. The upstream process holds a single
 * privileged client_credentials token for every caller, so sharing a process
 * would let one tenant act with another's token.
 *
 * The pool key is sha256(baseUrl + clientId + clientSecret); raw credential
 * values are never logged.
 *
 * Memory is the hard limit (WYREAI-711), and what counts is the PEAK of the
 * wrapper and of each child under SUSTAINED load, not idle sizes or a one-shot
 * call. scripts/sustained-load.mjs measures it with the real wrapper process,
 * real children and the real egress guard (Node 26, macOS; NOT Linux, NOT in the
 * image): wrapper idle ~85 and peak ~137 MiB (it runs --max-old-space-size=64),
 * child idle ~113 and peak ~126 MiB (one call at a time, a response of at most
 * the guard's 256 KiB cap), 2 children + the wrapper ~385 MiB, and a third child
 * starting on top ~485 MiB. Each child also runs with a heap cap so a runaway
 * child dies alone.
 *
 * poolCeilingForMemory turns those peaks into a child count with a 15% margin:
 * 1 child at 0.5 Gi (the fleet today, azure/vendor-fleet.bicep `memory`), 4 at
 * 1 Gi. The pool is never above max children plus the one replacement that
 * starts before an idle child is evicted. Beyond that a new credential waits in a
 * short, bounded queue and is then refused with PoolBusyError; it never spawns.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { AcronisCredentials } from "./credentials.js";
import { logger } from "./utils/logger.js";

/**
 * V8 old-space cap for each child (MiB). A runaway child dies alone instead of
 * taking the container. With one call at a time and responses of at most 256 KiB
 * a child ran cleanly under sustained load, with the wrapper stalled, at 32 MiB
 * (24 MiB ran at about 60% of the throughput, 16 would not start), so 80 is 2.5x
 * what it needs.
 */
export const CHILD_MAX_OLD_SPACE_MB = 80;
/** V8 young-generation cap for each child and the wrapper (MiB). The default costs ~20 MiB of RSS per process. */
export const MAX_SEMI_SPACE_MB = 1;
/** Peak RSS of a child (MiB): ~126 measured under sustained load, rounded up. */
export const CHILD_PEAK_MB = 130;
/** RSS of a child that has just started (MiB): ~113 measured. One extra starts before an idle child is evicted. */
export const CHILD_STARTUP_MB = 115;
/** Peak RSS of the wrapper under sustained load (MiB): ~137 measured with --max-old-space-size=64, rounded up. */
export const WRAPPER_PEAK_MB = 140;
/** Headroom kept on top of the measured peaks, as a fraction of the container's memory. */
export const MEMORY_MARGIN = 0.15;
/** Assumed container memory (MiB) when no limit can be read. Conservative on purpose. */
export const FALLBACK_MEMORY_MB = 512;
/** Hard ceiling on children whatever the memory. ACRONIS_POOL_MAX above the ceiling is clamped. */
export const MAX_POOL_MAX = 4;
/** Calls running at once in one child. More wait, in a bounded queue, then get PoolBusyError. */
export const MAX_CALLS_PER_CHILD = 1;
/** A child that has not answered `initialize` (it fetches its token first) by then is killed. */
export const SPAWN_TIMEOUT_MS = 30_000;
export const DEFAULT_POOL_IDLE_MS = 10 * 60 * 1000;
/** How long a new credential waits for a free pool slot when every child is busy. */
export const DEFAULT_POOL_WAIT_MS = 30_000;
/** At most this many callers wait for a slot; the next one is refused at once. */
export const DEFAULT_POOL_MAX_QUEUE = 8;
/**
 * A failed spawn (revoked or wrong credentials, no route) is remembered for
 * this long, keyed by the credential hash, so a bad credential cannot cause a
 * spawn per call. The cache holds at most MAX_FAILED_SPAWNS keys.
 */
export const FAILED_SPAWN_TTL_MS = 30_000;
export const MAX_FAILED_SPAWNS = 256;
export const UPSTREAM_PACKAGE = "@acronis-platform/mcp";

/**
 * How many children fit in a container with this memory limit (bytes): the
 * wrapper at its peak, one child still starting (the replacement), and the rest
 * at their peak, all inside the limit less MEMORY_MARGIN. Unknown or unlimited
 * (0, or a huge cgroup "no limit" value) falls back to 512 MiB. At least 1.
 */
export function poolCeilingForMemory(limitBytes: number | undefined = process.constrainedMemory()): number {
  const known = limitBytes !== undefined && limitBytes > 0 && limitBytes < 2 ** 50;
  const mb = known ? limitBytes / (1024 * 1024) : FALLBACK_MEMORY_MB;
  const usable = mb / (1 + MEMORY_MARGIN) - WRAPPER_PEAK_MB - CHILD_STARTUP_MB;
  return Math.max(1, Math.min(MAX_POOL_MAX, Math.floor(usable / CHILD_PEAK_MB)));
}

/**
 * Preloaded into every child (`node --require`). Lets the child reach only the
 * origin of its own API_BASE_URL and refuses redirects, so the client_secret in
 * the token request cannot be replayed to another host. Plain CJS at the repo
 * root so it resolves the same from src/ (tests) and dist/.
 */
const EGRESS_GUARD = fileURLToPath(new URL("../child-egress-guard.cjs", import.meta.url));

export interface UpstreamCallResult {
  content?: unknown;
  isError?: boolean;
  structuredContent?: unknown;
}

export interface UpstreamConnection {
  callTool(name: string, args: Record<string, unknown>): Promise<UpstreamCallResult>;
  listToolNames(): Promise<string[]>;
  close(): Promise<void>;
}

export interface SpawnContext {
  /** Call when the child exits on its own so the pool drops the entry. */
  onClose: () => void;
}

export type Spawner = (
  creds: AcronisCredentials,
  toolsInclude: readonly string[],
  ctx: SpawnContext
) => Promise<UpstreamConnection>;

export function credentialKey(creds: AcronisCredentials): string {
  return createHash("sha256")
    .update(creds.baseUrl)
    .update("\0")
    .update(creds.clientId)
    .update("\0")
    .update(creds.clientSecret)
    .digest("hex");
}

/** The exact environment given to the child. Nothing is inherited from the parent. */
export function buildChildEnv(
  creds: AcronisCredentials,
  toolsInclude: readonly string[],
  parentEnv: Record<string, string | undefined> = process.env
): Record<string, string> {
  return {
    PATH: parentEnv.PATH ?? "",
    NODE_ENV: parentEnv.NODE_ENV ?? "production",
    API_BASE_URL: creds.baseUrl,
    OAUTH_CLIENT_ID: creds.clientId,
    OAUTH_CLIENT_SECRET: creds.clientSecret,
    MCP_TRANSPORT: "stdio",
    MCP_TOOLS_INCLUDE: toolsInclude.join(","),
  };
}

/** Resolve the pinned package's bin script (bin/cli.js) next to its package.json. */
export function resolveUpstreamBin(): string {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve(`${UPSTREAM_PACKAGE}/package.json`);
  return join(dirname(pkgPath), "bin", "cli.js");
}

/**
 * Real spawner: Node child over stdio via @modelcontextprotocol/client.
 * `extraEnv` exists for the integration test (local token endpoint, temp HOME);
 * production always uses the no-argument `spawnUpstream`.
 */
export function createStdioSpawner(
  extraEnv: Record<string, string> = {},
  { spawnTimeoutMs = SPAWN_TIMEOUT_MS }: { spawnTimeoutMs?: number } = {}
): Spawner {
  return async (creds, toolsInclude, ctx) => {
    // Upstream writes an (encrypted) token cache under $HOME/.mcp. Give every
    // child its own private, throwaway HOME so tenants never share a cache
    // directory; it is removed when the child closes.
    const childHome = await mkdtemp(join(tmpdir(), "acronis-tenant-"));
    await chmod(childHome, 0o700);
    const removeHome = () => rm(childHome, { recursive: true, force: true }).catch(() => undefined);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--require", EGRESS_GUARD, `--max-old-space-size=${CHILD_MAX_OLD_SPACE_MB}`, `--max-semi-space-size=${MAX_SEMI_SPACE_MB}`, resolveUpstreamBin()],
      env: { ...buildChildEnv(creds, toolsInclude), HOME: childHome, ...extraEnv },
      stderr: "pipe",
    });
    // Drain stderr so the child never blocks. Only a bounded tail is kept, and
    // only to explain a failed start; callers redact it before it leaves.
    let stderrTail = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-1000);
    });
    const client = new Client({ name: "acronis-mcp-wrapper", version: "1.0.0" });
    let closing = false;
    transport.onclose = () => {
      void removeHome();
      if (!closing) ctx.onClose();
    };
    try {
      await client.connect(transport, { timeout: spawnTimeoutMs });
    } catch (err) {
      closing = true;
      await transport.close().catch(() => undefined);
      await removeHome();
      const detail = stderrTail.trim().split("\n")[0]?.slice(0, 300);
      const base = err instanceof Error ? err.message : String(err);
      throw new Error(detail ? `${base}: ${detail}` : base, { cause: err });
    }
    return {
      callTool: async (name, args) =>
        (await client.callTool({ name, arguments: args })) as UpstreamCallResult,
      listToolNames: async () => {
        const names: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined);
          names.push(...page.tools.map((t) => t.name));
          cursor = page.nextCursor;
        } while (cursor);
        return names;
      },
      close: async () => {
        closing = true;
        await client.close().catch(() => undefined);
        await transport.close().catch(() => undefined);
        await removeHome();
      },
    };
  };
}

export const spawnUpstream: Spawner = createStdioSpawner();

let defaultSpawner: Spawner = spawnUpstream;
/** Test seam: swap the spawner used by pools created without one. Pass undefined to restore. */
export function setDefaultSpawner(spawner: Spawner | undefined): void {
  defaultSpawner = spawner ?? spawnUpstream;
}

interface Entry {
  key: string;
  conn: Promise<UpstreamConnection>;
  lastUsed: number;
  /** Callers holding this entry: running a call, or waiting for a call slot. */
  inUse: number;
  /** Calls running in the child right now (at most MAX_CALLS_PER_CHILD). */
  running: number;
  /** Callers waiting for a call slot in this child. */
  callWaiters: Array<() => void>;
  /** Removed from the map; close once inUse hits zero. */
  retired: boolean;
}

/** The pool is full of busy children and the wait queue is full or timed out (a 429). */
export class PoolBusyError extends Error {
  constructor() {
    super("Acronis is busy with other requests right now. Try again in a moment.");
    this.name = "PoolBusyError";
  }
}

export interface PoolOptions {
  toolsInclude: readonly string[];
  spawner?: Spawner;
  /** Max children; clamped to the ceiling for the container's memory. Default: that ceiling. */
  max?: number | undefined;
  /** Container memory limit in bytes. Default: process.constrainedMemory() (0 or unknown means 512 MiB). */
  memoryLimitBytes?: number;
  idleMs?: number;
  /** Max wait for a free slot (pool slot or a child's call slot) when everything is busy. */
  waitMs?: number;
  /** Max callers waiting for a slot at once (per queue). */
  maxQueue?: number;
  /** How long a failed spawn is remembered. */
  failedSpawnTtlMs?: number;
  now?: () => number;
}

function positiveInt(raw: string | undefined): number | undefined {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function poolOptionsFromEnv(
  env: Record<string, string | undefined> = process.env
): { max: number | undefined; idleMs: number; memoryLimitBytes?: number } {
  const memoryLimitMb = positiveInt(env.ACRONIS_MEMORY_LIMIT_MB);
  return {
    max: positiveInt(env.ACRONIS_POOL_MAX),
    idleMs: positiveInt(env.ACRONIS_POOL_IDLE_MS) ?? DEFAULT_POOL_IDLE_MS,
    ...(memoryLimitMb ? { memoryLimitBytes: memoryLimitMb * 1024 * 1024 } : {}),
  };
}

/**
 * Wait in `queue` until woken ("woken"), `ms` pass ("timeout") or `signal`
 * aborts (rejects). Leaving the queue is immediate in every case, so a caller
 * that disconnected never holds a queue place.
 */
function parkInQueue(queue: Array<() => void>, ms: number, signal?: AbortSignal): Promise<"woken" | "timeout"> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Request aborted"));
    const leave = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const i = queue.indexOf(wake);
      if (i >= 0) queue.splice(i, 1);
    };
    const wake = () => {
      leave();
      resolve("woken");
    };
    const onAbort = () => {
      leave();
      reject(signal?.reason ?? new Error("Request aborted"));
    };
    const timer = setTimeout(() => {
      leave();
      resolve("timeout");
    }, ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    queue.push(wake);
  });
}

export class UpstreamPool {
  private readonly entries = new Map<string, Entry>(); // insertion order == LRU order
  /** Retired children still serving a call; closed when their last call ends (and on shutdown). */
  private readonly draining = new Set<Entry>();
  /** Callers waiting for a free pool slot (every indexed child busy, or a replacement spawning). */
  private readonly waiters: Array<() => void> = [];
  /** A new child is starting in place of an idle one, so the pool is briefly one over max. At most one. */
  private replacing = false;
  /** Failed spawns by credential key (insertion order == age), kept for failedSpawnTtlMs. */
  private readonly failedSpawns = new Map<string, { until: number; error: Error }>();
  private readonly waitMs: number;
  private readonly maxQueue: number;
  private readonly failedSpawnTtlMs: number;
  private readonly spawner: Spawner;
  private readonly toolsInclude: readonly string[];
  private readonly max: number;
  private readonly idleMs: number;
  private readonly now: () => number;
  private sweeper: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(opts: PoolOptions) {
    this.spawner = opts.spawner ?? defaultSpawner;
    this.toolsInclude = [...opts.toolsInclude];
    const ceiling = poolCeilingForMemory(opts.memoryLimitBytes);
    const requestedMax = opts.max ?? ceiling;
    this.max = Math.min(requestedMax, ceiling);
    if (requestedMax > ceiling) {
      logger.warn("Pool max clamped to what the container's memory allows", { requested: requestedMax, max: this.max });
    }
    this.idleMs = opts.idleMs ?? DEFAULT_POOL_IDLE_MS;
    this.waitMs = opts.waitMs ?? DEFAULT_POOL_WAIT_MS;
    this.maxQueue = opts.maxQueue ?? DEFAULT_POOL_MAX_QUEUE;
    this.failedSpawnTtlMs = opts.failedSpawnTtlMs ?? FAILED_SPAWN_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * Run fn with the child for these credentials, spawning it on first use. At
   * most MAX_CALLS_PER_CHILD calls run in one child; the rest wait. `signal`
   * (the caller disconnecting) removes a waiting caller from every queue.
   */
  async withConnection<T>(
    creds: AcronisCredentials,
    fn: (conn: UpstreamConnection) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    if (this.closed) throw new Error("Upstream pool is closed");
    this.evictIdle();
    const key = credentialKey(creds);
    const entry = await this.acquire(key, creds, signal);
    try {
      const conn = await entry.conn;
      await this.enterCall(entry, signal);
      try {
        return await fn(conn);
      } finally {
        this.leaveCall(entry);
      }
    } finally {
      entry.inUse--;
      entry.lastUsed = this.now();
      if (entry.inUse === 0) {
        if (entry.retired) {
          this.draining.delete(entry);
          void this.closeEntry(entry);
        }
        this.wake();
      }
    }
  }

  /** Take one of the child's call slots, waiting (bounded) if both are taken. */
  private async enterCall(entry: Entry, signal?: AbortSignal): Promise<void> {
    if (entry.running < MAX_CALLS_PER_CHILD) {
      entry.running++;
      return;
    }
    if (entry.callWaiters.length >= this.maxQueue) throw new PoolBusyError();
    // Woken means leaveCall handed this caller the slot (running is unchanged).
    if ((await parkInQueue(entry.callWaiters, this.waitMs, signal)) === "timeout") throw new PoolBusyError();
  }

  private leaveCall(entry: Entry): void {
    const next = entry.callWaiters.shift();
    if (next) next();
    else entry.running--;
  }

  /**
   * Find or spawn the child for key and mark it in use. Busy children are
   * never evicted: when the pool is full and every child is busy, a new
   * credential waits for a slot (up to waitMs), then fails with PoolBusyError.
   * When the pool is full but a child is idle, the new child spawns first and
   * the idle one is evicted only once the new one is up (see create).
   */
  private async acquire(key: string, creds: AcronisCredentials, signal?: AbortSignal): Promise<Entry> {
    const deadline = this.now() + this.waitMs;
    for (;;) {
      signal?.throwIfAborted();
      if (this.closed) throw new Error("Upstream pool is closed");
      const existing = this.entries.get(key);
      if (existing) {
        // refresh LRU position
        this.entries.delete(key);
        this.entries.set(key, existing);
        existing.lastUsed = this.now();
        existing.inUse++;
        return existing;
      }
      const failed = this.recentSpawnFailure(key);
      if (failed) throw failed;
      const room = this.entries.size < this.max;
      const victim = room || this.replacing ? undefined : this.leastRecentlyUsedIdle();
      if (room || victim) {
        const entry = this.create(key, creds, victim);
        entry.inUse++;
        return entry;
      }
      const remaining = deadline - this.now();
      if (remaining <= 0 || this.waiters.length >= this.maxQueue) throw new PoolBusyError();
      await parkInQueue(this.waiters, remaining, signal); // woken or timed out: look again
    }
  }

  /** The error of a spawn that failed for this credential within the TTL, if any. */
  private recentSpawnFailure(key: string): Error | undefined {
    const failed = this.failedSpawns.get(key);
    if (!failed) return undefined;
    if (failed.until > this.now()) return failed.error;
    this.failedSpawns.delete(key);
    return undefined;
  }

  private rememberSpawnFailure(key: string, error: Error): void {
    this.failedSpawns.delete(key); // re-insert so the oldest entry is always first
    this.failedSpawns.set(key, { until: this.now() + this.failedSpawnTtlMs, error });
    // Bounded: drop the oldest entries beyond the cap.
    for (const oldest of this.failedSpawns.keys()) {
      if (this.failedSpawns.size <= MAX_FAILED_SPAWNS) break;
      this.failedSpawns.delete(oldest);
    }
  }

  private leastRecentlyUsedIdle(): Entry | undefined {
    return [...this.entries.values()].find((e) => e.inUse === 0);
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  /**
   * Spawn the child for key. With a `victim` (the pool is full), an idle child
   * is evicted only after this spawn succeeds, so a stream of bad or varying
   * credentials, whose spawns fail, cannot push healthy tenants' idle children
   * out. The victim is chosen again when the spawn finishes, because the one
   * picked earlier may have been called in the meantime; if no child is idle by
   * then, the newcomer is refused (and its child closed) rather than exceed the
   * process budget. So the pool is never above max children plus this one
   * replacement, and `replacing` keeps it to one.
   */
  private create(key: string, creds: AcronisCredentials, victim?: Entry): Entry {
    const entry: Entry = {
      key,
      lastUsed: this.now(),
      inUse: 0,
      running: 0,
      callWaiters: [],
      retired: false,
      conn: undefined as unknown as Promise<UpstreamConnection>,
    };
    const spawned = this.spawner(creds, this.toolsInclude, {
      onClose: () => this.drop(entry),
    });
    entry.conn = victim ? spawned.then((conn) => this.evictForReplacement(entry, victim, conn)) : spawned;
    entry.conn.catch((error: unknown) => {
      this.drop(entry);
      // Remember a failed spawn briefly so a bad credential cannot respawn on every call.
      // A refusal for lack of an idle child to replace says nothing about the credential.
      if (!(error instanceof PoolBusyError)) {
        this.rememberSpawnFailure(key, error instanceof Error ? error : new Error(String(error)));
      }
    });
    if (victim) {
      this.replacing = true;
      entry.conn
        .catch(() => undefined)
        .then(() => {
          this.replacing = false;
          this.wake();
        });
    }
    this.entries.set(key, entry);
    logger.debug("Upstream child spawned", { poolKey: key.slice(0, 12), size: this.entries.size });
    this.startSweeper();
    return entry;
  }

  /** The newcomer's child is up: make room by closing an idle child, or refuse the newcomer. */
  private async evictForReplacement(
    newcomer: Entry,
    preferred: Entry,
    conn: UpstreamConnection
  ): Promise<UpstreamConnection> {
    if (this.entries.size <= this.max) return conn; // an idle sweep or a child exit already made room
    const idle = (e: Entry) => e !== newcomer && e.inUse === 0 && this.entries.get(e.key) === e;
    const victim = idle(preferred) ? preferred : [...this.entries.values()].find(idle);
    if (!victim) {
      await conn.close().catch(() => undefined);
      throw new PoolBusyError();
    }
    logger.debug("Upstream child evicted (LRU)", { poolKey: victim.key.slice(0, 12) });
    this.drop(victim);
    return conn;
  }

  private drop(entry: Entry): void {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    if (entry.retired) return;
    entry.retired = true;
    if (entry.inUse === 0) void this.closeEntry(entry);
    else this.draining.add(entry); // still serving: keep tracked so close() reaches it
    this.wake();
  }

  /** Evict entries idle longer than idleMs. */
  evictIdle(): number {
    const cutoff = this.now() - this.idleMs;
    let n = 0;
    for (const entry of [...this.entries.values()]) {
      if (entry.inUse === 0 && entry.lastUsed <= cutoff) {
        logger.debug("Upstream child evicted (idle)", { poolKey: entry.key.slice(0, 12) });
        this.drop(entry);
        n++;
      }
    }
    return n;
  }

  private startSweeper(): void {
    if (this.sweeper || this.closed) return;
    const every = Math.max(1000, Math.min(60_000, Math.floor(this.idleMs / 2)));
    this.sweeper = setInterval(() => this.evictIdle(), every);
    this.sweeper.unref();
  }

  private async closeEntry(entry: Entry): Promise<void> {
    try {
      const conn = await entry.conn;
      await conn.close();
    } catch {
      /* spawn failed or already closed */
    }
  }

  /** Close every child (shutdown). */
  async close(): Promise<void> {
    this.closed = true;
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
    const all = [...this.entries.values(), ...this.draining];
    this.entries.clear();
    this.draining.clear();
    this.wake();
    await Promise.all(
      all.map((e) => {
        e.retired = true;
        return this.closeEntry(e);
      })
    );
  }
}
