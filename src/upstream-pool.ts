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
 * real children and the real egress guard (macOS with Node 26, and the Linux CI
 * job with Node 22 and 24; NOT in the image): wrapper idle ~85 and peak 123-137
 * MiB (it runs --max-old-space-size=64), child idle ~113 and peak 126 (macOS) to
 * 141 (Linux, Node 24) MiB (one call at a time, a response of at most the guard's
 * 256 KiB cap). Each child also runs with a heap cap so a runaway child dies alone.
 *
 * poolCeilingForMemory turns those peaks into a child count with a 15% margin:
 * 1 child at 0.5 Gi (the fleet today, azure/vendor-fleet.bicep `memory`), 2 at
 * 0.75 Gi, 4 at 1 Gi. Live processes are never above max plus the one replacement that
 * starts before an idle child is evicted. A child that has left the pool (replaced, evicted
 * for idleness or crashed) still counts until its process has exited (one that was still
 * starting, until its spawn has ended and its close has finished), so nothing starts in its
 * place before then. At most one replacement runs at a time. Beyond that a new credential waits in a short, bounded
 * queue and is then refused with PoolBusyError; it never spawns.
 *
 * Fairness: a child serves its tenant freely while nobody else waits. Once another
 * credential is waiting for a slot and the child has held its slot for a time slice
 * (DEFAULT_POOL_SLICE_MS), it takes no NEW calls; its in-flight calls finish, it goes
 * idle, and the slot passes to the waiters in arrival order. Without this a tenant
 * with a steady stream of calls keeps its child busy for ever and nobody else gets in.
 * If the newcomer's child then fails to start, the incumbent gets a fresh slice before it is
 * asked again, so rotating bad credentials cannot hold a healthy incumbent for more than one
 * failed spawn per slice (see `create`). They can still fill the wait queue and get a
 * non-incumbent tenant refused, and a valid newcomer waits a slice per bad credential ahead of it.
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
/** Peak RSS of a child (MiB): 126 on macOS, 139-141 on Linux (Node 24 in CI) under sustained load, rounded up. */
export const CHILD_PEAK_MB = 145;
/** RSS of a child that has just started (MiB): ~113 measured. One extra starts before an idle child is evicted. */
export const CHILD_STARTUP_MB = 115;
/** Peak RSS of the wrapper under sustained load (MiB): 137 on macOS, 123-128 on Linux, with --max-old-space-size=64, rounded up. */
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
/**
 * The same for a child that replaces an idle one. Until it is up the idle child
 * takes no new calls, so a slow or tarpitted newcomer must not hold a healthy
 * tenant for the full SPAWN_TIMEOUT_MS.
 */
export const REPLACEMENT_SPAWN_TIMEOUT_MS = 8_000;
export const DEFAULT_POOL_IDLE_MS = 10 * 60 * 1000;
/** How long a new credential waits for a free pool slot when every child is busy. */
export const DEFAULT_POOL_WAIT_MS = 30_000;
/** At most this many callers wait for a slot; the next one is refused at once. */
export const DEFAULT_POOL_MAX_QUEUE = 8;
/** Of those, at most this many are for one credential, so a tenant's parallel callers cannot fill the queue. */
export const MAX_WAITERS_PER_CREDENTIAL = 3;
/**
 * How long a child serves its tenant before it must make way for a waiting
 * credential. A swap costs a child start (token fetch, ~115 MiB), so the slice is
 * long enough to amortise it and short enough that a waiter is served well inside
 * DEFAULT_POOL_WAIT_MS.
 */
export const DEFAULT_POOL_SLICE_MS = 10_000;
/** ACRONIS_POOL_SLICE_MS is clamped to this and to half the wait: a smaller slice is a respawn per call. */
export const MIN_POOL_SLICE_MS = 1_000;
/**
 * How long the pool waits for a child to finish closing. The stdio transport already
 * escalates (stdin EOF, 2 s, SIGTERM, 2 s, SIGKILL), so this only bounds a close
 * that never returns, so one stuck child cannot hold up every later replacement.
 */
export const CLOSE_TIMEOUT_MS = 8_000;
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
  /** Overrides the spawner's own timeout for this spawn (a replacement spawn is given a shorter one). */
  spawnTimeoutMs?: number;
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

/** The stdio transport, remembering its child's pid: the SDK drops it as soon as it starts to close. */
class ChildTransport extends StdioClientTransport {
  childPid: number | null = null;
  override async start(): Promise<void> {
    await super.start();
    this.childPid = this.pid;
  }
}

/**
 * SIGKILL a child and wait until the process has really exited (bounded). A failed
 * spawn must not leave its child alive after the pool has let go of it: the pool's
 * process budget (max + 1) counts live processes. The SDK closes the transport itself
 * when connect times out, so a later transport.close() returns at once and says nothing.
 */
async function killAndWait(pid: number | null, timeoutMs = 2_000): Promise<void> {
  if (pid === null) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return; // already gone
  }
  const alive = () => {
    try {
      return process.kill(pid, 0);
    } catch {
      return false;
    }
  };
  for (const until = Date.now() + timeoutMs; alive() && Date.now() < until; ) await new Promise((r) => setTimeout(r, 20));
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
    const removeHome = () => rm(childHome, { recursive: true, force: true }).catch(() => undefined);
    try {
      await chmod(childHome, 0o700);
    } catch (err) {
      await removeHome();
      throw err;
    }
    const transport = new ChildTransport({
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
      // The pool may ask for a shorter timeout (a replacement spawn); never a longer one.
      await client.connect(transport, { timeout: Math.min(ctx.spawnTimeoutMs ?? spawnTimeoutMs, spawnTimeoutMs) });
    } catch (err) {
      closing = true;
      await killAndWait(transport.childPid); // the pool counts this child until it has really exited
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

/** A caller parked in a queue. `key` is its credential (empty for a call slot). */
interface Waiter {
  key: string;
  wake: () => void;
}

interface Entry {
  key: string;
  conn: Promise<UpstreamConnection>;
  /**
   * When the child's time slice ends: from then on it makes way for a waiting credential, and
   * (idle) may be replaced. A slice after it was created, or after the last replacement of it failed.
   */
  sliceEndsAt: number;
  lastUsed: number;
  /** Callers holding this entry: running a call, or waiting for a call slot. */
  inUse: number;
  /** Calls running in the child right now (at most MAX_CALLS_PER_CHILD). */
  running: number;
  /** Callers waiting for a call slot in this child. */
  callWaiters: Waiter[];
  /** Removed from the map; close once inUse hits zero. */
  retired: boolean;
  /** Set when the close starts, so closing twice (eviction, then shutdown) is one close. */
  closing?: Promise<void>;
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
  /** How long a child serves its tenant, while others wait, before it takes no new calls. */
  sliceMs?: number;
  /** How long to wait for a child to finish closing before moving on. */
  closeTimeoutMs?: number;
  now?: () => number;
}

function positiveInt(raw: string | undefined): number | undefined {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Pool options from the environment. ACRONIS_MEMORY_LIMIT_MB can only LOWER the
 * memory the pool sizes itself for: it is capped at the limit Node reads from the
 * container (`constrainedMemory`), and ignored when Node cannot read one, in which
 * case the pool keeps the conservative 512 MiB (one child). So a wrong value cannot
 * raise the ceiling past what the container has.
 */
export function poolOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
  constrainedMemory: number | undefined = process.constrainedMemory()
): { max: number | undefined; idleMs: number; sliceMs: number; memoryLimitBytes?: number } {
  const requestedMb = positiveInt(env.ACRONIS_MEMORY_LIMIT_MB);
  const known = constrainedMemory !== undefined && constrainedMemory > 0 && constrainedMemory < 2 ** 50;
  if (requestedMb && !known) {
    logger.warn("ACRONIS_MEMORY_LIMIT_MB ignored: the container's memory limit cannot be read, so the pool assumes 512 MiB");
  }
  return {
    max: positiveInt(env.ACRONIS_POOL_MAX),
    idleMs: positiveInt(env.ACRONIS_POOL_IDLE_MS) ?? DEFAULT_POOL_IDLE_MS,
    // Not below 1 s (every swap would be a cold start) and not above half the wait (a waiter would time out first).
    sliceMs: Math.min(
      Math.max(positiveInt(env.ACRONIS_POOL_SLICE_MS) ?? DEFAULT_POOL_SLICE_MS, MIN_POOL_SLICE_MS),
      DEFAULT_POOL_WAIT_MS / 2
    ),
    ...(requestedMb && known ? { memoryLimitBytes: Math.min(requestedMb * 1024 * 1024, constrainedMemory) } : {}),
  };
}

/**
 * Wait in `queue` until woken ("woken"), `ms` pass ("timeout") or `signal`
 * aborts (rejects). Leaving the queue is immediate in every case, so a caller
 * that disconnected never holds a queue place.
 */
function parkInQueue(queue: Waiter[], ms: number, signal?: AbortSignal, key = ""): Promise<"woken" | "timeout"> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Request aborted"));
    const leave = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const i = queue.indexOf(waiter);
      if (i >= 0) queue.splice(i, 1);
    };
    const waiter: Waiter = {
      key,
      wake: () => {
        leave();
        resolve("woken");
      },
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
    queue.push(waiter);
  });
}

/** `promise`, or a rejection with the abort reason as soon as `signal` aborts. */
function rejectOnAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("Request aborted"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Resolves when `promise` settles or after `ms`, whichever comes first. Never rejects. */
function settledWithin(promise: Promise<unknown>, ms: number, onTimeout?: () => void): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      resolve();
    }, ms);
    timer.unref();
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    promise.then(done, done);
  });
}

export class UpstreamPool {
  private readonly entries = new Map<string, Entry>(); // insertion order == LRU order
  /** Retired children still serving a call; closed when their last call ends (and on shutdown). */
  private readonly draining = new Set<Entry>();
  /** Callers parked until the pool changes (every indexed child busy, or a replacement spawning), oldest first. */
  private readonly waiters: Waiter[] = [];
  /**
   * Credentials with a caller still looking for a slot, and how many: parked, or
   * woken and not yet through. Kept apart from `waiters`, because waking empties that
   * queue before the woken callers have run, and a child must not read that as "nobody waits".
   */
  private readonly waitingFor = new Map<string, number>();
  /**
   * Children that have left `entries` but whose close has not finished (evicted for
   * idleness, replaced, or gone after a crash). They are still processes, so they count
   * toward capacity until the close resolves; see `live`.
   */
  private readonly closingEntries = new Set<Entry>();
  /** The idle child a starting newcomer is replacing, until that newcomer is up or has failed. Claims it: no second replacement starts meanwhile. */
  private replacementVictim: Entry | undefined;
  /** Failed spawns by credential key (insertion order == age), kept for failedSpawnTtlMs. */
  private readonly failedSpawns = new Map<string, { until: number; error: Error }>();
  private readonly waitMs: number;
  private readonly maxQueue: number;
  private readonly failedSpawnTtlMs: number;
  private readonly spawner: Spawner;
  private readonly toolsInclude: readonly string[];
  private readonly max: number;
  private readonly idleMs: number;
  private readonly sliceMs: number;
  private readonly closeTimeoutMs: number;
  private readonly now: () => number;
  private sweeper: NodeJS.Timeout | undefined;
  private agingTimer: NodeJS.Timeout | undefined;
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
    this.sliceMs = opts.sliceMs ?? DEFAULT_POOL_SLICE_MS;
    this.closeTimeoutMs = opts.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;
    this.waitMs = opts.waitMs ?? DEFAULT_POOL_WAIT_MS;
    this.maxQueue = opts.maxQueue ?? DEFAULT_POOL_MAX_QUEUE;
    this.failedSpawnTtlMs = opts.failedSpawnTtlMs ?? FAILED_SPAWN_TTL_MS;
    this.now = opts.now ?? Date.now;
    const limit = opts.memoryLimitBytes ?? process.constrainedMemory();
    logger.info("Upstream pool", {
      memoryLimitMb: limit > 0 && limit < 2 ** 50 ? Math.round(limit / 1024 / 1024) : `unknown (assuming ${FALLBACK_MEMORY_MB})`,
      ceiling,
      max: this.max,
      sliceMs: this.sliceMs,
    });
  }

  get size(): number {
    return this.entries.size;
  }

  /** Children that exist as processes: the pool's entries plus those still closing. */
  private get live(): number {
    return this.entries.size + this.closingEntries.size;
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
      const conn = await rejectOnAbort(entry.conn, signal);
      await this.enterCall(entry, signal);
      try {
        signal?.throwIfAborted(); // a caller that has gone must not run fn: it may be a write
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

  /** Take the child's call slot, waiting if it is taken. `acquire` has already kept the callers of one child to MAX_CALLS_PER_CHILD plus maxQueue. */
  private async enterCall(entry: Entry, signal?: AbortSignal): Promise<void> {
    if (entry.running < MAX_CALLS_PER_CHILD) {
      entry.running++;
      return;
    }
    // Woken means leaveCall handed this caller the slot (running is unchanged).
    if ((await parkInQueue(entry.callWaiters, this.waitMs, signal)) === "timeout") throw new PoolBusyError();
  }

  private leaveCall(entry: Entry): void {
    const next = entry.callWaiters.shift();
    if (next) next.wake();
    else entry.running--;
  }

  /**
   * Find or spawn the child for key and mark it in use. Busy children are
   * never evicted: when the pool is full and every child is busy, a new
   * credential waits for a slot (up to waitMs), then fails with PoolBusyError.
   * When the pool is full but a child is idle, the new child spawns first and
   * the idle one is evicted only once the new one is up (see create).
   *
   * A caller for a child that must make way (see mustYield) waits like a new
   * credential, behind whoever is already waiting.
   */
  private async acquire(key: string, creds: AcronisCredentials, signal?: AbortSignal): Promise<Entry> {
    const deadline = this.now() + this.waitMs;
    let waiting = false;
    try {
      for (;;) {
        signal?.throwIfAborted();
        if (this.closed) throw new Error("Upstream pool is closed");
        const existing = this.entries.get(key);
        if (existing) {
          if (!this.mustYield(existing)) {
            // The cap holds while the child is still starting too: one running, maxQueue waiting.
            if (existing.inUse >= MAX_CALLS_PER_CHILD + this.maxQueue) throw new PoolBusyError();
            // refresh LRU position
            this.entries.delete(key);
            this.entries.set(key, existing);
            existing.lastUsed = this.now();
            existing.inUse++;
            return existing;
          }
        } else {
          const failed = this.recentSpawnFailure(key);
          if (failed) throw failed;
          // Children still closing count as live, so there is only room once they have exited.
          // A full pool of the pool's own children, with nothing closing and no replacement
          // under way, may replace an idle one. One replacement at a time: it claims its victim
          // until the newcomer settles, and a second could otherwise claim that victim too.
          const room = this.live < this.max;
          const full = this.entries.size === this.max && this.closingEntries.size === 0 && !this.replacementVictim;
          const victim = full ? this.leastRecentlyUsedIdle() : undefined;
          if (room || victim) {
            const entry = this.create(key, creds, victim);
            entry.inUse++;
            return entry;
          }
        }
        if (!waiting) {
          waiting = true;
          this.waitingFor.set(key, (this.waitingFor.get(key) ?? 0) + 1);
        }
        await this.waitForSlot(key, deadline, signal); // woken or timed out: look again
      }
    } catch (error) {
      if (waiting) {
        waiting = false;
        this.stopWaiting(key);
        this.wake(); // gave up (busy, disconnected, bad credential): callers that stood back for this one can look again
      }
      throw error;
    } finally {
      if (waiting) this.stopWaiting(key);
    }
  }

  private stopWaiting(key: string): void {
    const left = (this.waitingFor.get(key) ?? 1) - 1;
    if (left > 0) this.waitingFor.set(key, left);
    else this.waitingFor.delete(key);
  }

  /**
   * Is this child to take no new calls? Yes when it is the child being replaced,
   * and yes once it has held its slot for a time slice and a different credential
   * is waiting for one. Its in-flight calls finish, so it goes idle and the slot
   * can pass. Otherwise, and always when nobody waits, a child serves its tenant
   * without limit.
   */
  private mustYield(entry: Entry): boolean {
    if (this.replacementVictim === entry) return true;
    if (this.now() < entry.sliceEndsAt) return false;
    return [...this.waitingFor.keys()].some((k) => k !== entry.key);
  }

  /**
   * Park until the pool changes (or an idle child has aged enough to be replaced), or
   * fail with PoolBusyError if the queue is full, this credential already has
   * MAX_WAITERS_PER_CREDENTIAL callers in it, or the deadline has passed. The
   * per-credential cap keeps one tenant's parallel callers from filling the queue.
   */
  private async waitForSlot(key: string, deadline: number, signal?: AbortSignal): Promise<void> {
    const remaining = deadline - this.now();
    const own = this.waitingFor.get(key) ?? 0; // includes this caller
    if (remaining <= 0 || this.waiters.length >= this.maxQueue || own > MAX_WAITERS_PER_CREDENTIAL) throw new PoolBusyError();
    this.wakeWhenAChildHasAged();
    await parkInQueue(this.waiters, remaining, signal, key);
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

  /**
   * The oldest-used idle child that has been up for at least a time slice. A younger
   * one is not replaced, so a slot is not respawned more often than once per slice
   * however briefly its tenant pauses; its waiters are woken when it has aged.
   */
  private leastRecentlyUsedIdle(): Entry | undefined {
    return [...this.entries.values()].find((e) => e.inUse === 0 && this.now() >= e.sliceEndsAt);
  }

  /**
   * Wake the waiters when the soonest idle child that is too young to replace has aged.
   * One timer for the pool, not one per waiter: wake() resumes them in the order they
   * arrived, where separate timers would resume them in timer order.
   */
  private wakeWhenAChildHasAged(): void {
    if (this.agingTimer) return;
    const waits = [...this.entries.values()]
      .filter((e) => e.inUse === 0)
      .map((e) => e.sliceEndsAt - this.now())
      .filter((ms) => ms > 0);
    if (!waits.length) return;
    this.agingTimer = setTimeout(() => {
      this.agingTimer = undefined;
      this.wake();
    }, Math.min(...waits));
    this.agingTimer.unref();
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w.wake();
  }

  /**
   * Spawn the child for key. With a `victim` (the pool is full), the idle child
   * is closed only after this spawn succeeds, so a stream of bad or varying
   * credentials, whose spawns fail, cannot push healthy tenants' idle children
   * out. From the moment the spawn starts the victim takes no new calls (see
   * mustYield): its callers wait for a slot like a new credential, behind the
   * newcomer, so the victim is still idle when the newcomer is up. So the pool is
   * never above max children plus this one replacement: the victim keeps counting
   * as live until it has exited (see `live`), and nothing else starts before that.
   *
   * If the spawn fails the victim stays, and gets a whole new slice (sliceEndsAt)
   * before it may be asked to make way again. That bounds what a stream of distinct
   * bad credentials, which the per-credential negative cache does not stop, can take
   * from a healthy tenant: it is held for one failed spawn (REPLACEMENT_SPAWN_TIMEOUT_MS
   * at the very most) per slice it serves, so it keeps at least
   * sliceMs / (sliceMs + REPLACEMENT_SPAWN_TIMEOUT_MS) of its time: 56% at the default
   * 10 s slice if every bad spawn runs to its timeout, 87% if each fails after 1.5 s.
   */
  private create(key: string, creds: AcronisCredentials, victim?: Entry): Entry {
    const entry: Entry = {
      key,
      sliceEndsAt: this.now() + this.sliceMs,
      lastUsed: this.now(),
      inUse: 0,
      running: 0,
      callWaiters: [],
      retired: false,
      conn: undefined as unknown as Promise<UpstreamConnection>,
    };
    const spawned = this.spawner(creds, this.toolsInclude, {
      onClose: () => this.drop(entry),
      ...(victim ? { spawnTimeoutMs: REPLACEMENT_SPAWN_TIMEOUT_MS } : {}),
    });
    entry.conn = victim ? spawned.then((conn) => this.closeVictim(victim, conn)) : spawned;
    if (victim) this.replacementVictim = victim;
    entry.conn
      .catch((error: unknown) => {
        this.drop(entry);
        // Remember a failed spawn briefly so a bad credential cannot respawn on every call.
        this.rememberSpawnFailure(key, error instanceof Error ? error : new Error(String(error)));
        // The victim sat out this attempt for nothing. It serves a whole slice before another
        // credential may ask it to make way again (see mustYield).
        if (victim) victim.sliceEndsAt = this.now() + this.sliceMs;
      })
      .finally(() => {
        if (!victim) return;
        this.replacementVictim = undefined; // the newcomer is up (the victim is closing) or failed (the victim stays)
        this.wake();
      });
    this.entries.set(key, entry);
    logger.debug("Upstream child spawned", { poolKey: key.slice(0, 12), size: this.entries.size });
    this.startSweeper();
    return entry;
  }

  /** The newcomer's child is up: close the idle child it replaces, unless a sweep or a child exit already made room. */
  private closeVictim(victim: Entry, conn: UpstreamConnection): UpstreamConnection {
    if (this.entries.size > this.max) {
      logger.debug("Upstream child evicted (LRU)", { poolKey: victim.key.slice(0, 12) });
      this.drop(victim);
    }
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

  /**
   * Close the entry's child, once. The child counts toward capacity until its process has
   * exited: for a child that is still starting that is when its spawn ends (the spawner kills it
   * at its own timeout, at most SPAWN_TIMEOUT_MS), then its close, which is capped at
   * closeTimeoutMs so a close that never returns cannot hold a slot for ever. The returned
   * promise, which shutdown waits on, is capped at closeTimeoutMs in all: a starting child is
   * closed whenever it comes up, but nobody waits for it for up to 30 s.
   */
  private closeEntry(entry: Entry): Promise<void> {
    if (!entry.closing) {
      this.closingEntries.add(entry);
      const exited = entry.conn
        .then((conn) =>
          settledWithin(conn.close(), this.closeTimeoutMs, () =>
            logger.warn("Upstream child did not close in time", { poolKey: entry.key.slice(0, 12) })
          )
        )
        .catch(() => undefined) // spawn failed (its child is already dead) or close threw
        .finally(() => {
          this.closingEntries.delete(entry);
          this.wake(); // there may be room now
        });
      entry.closing = settledWithin(exited, this.closeTimeoutMs);
    }
    return entry.closing;
  }

  /** Close every child (shutdown). */
  async close(): Promise<void> {
    this.closed = true;
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
    clearTimeout(this.agingTimer);
    this.agingTimer = undefined;
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
