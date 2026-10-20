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
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { AcronisCredentials } from "./credentials.js";
import { logger } from "./utils/logger.js";

export const DEFAULT_POOL_MAX = 50;
export const DEFAULT_POOL_IDLE_MS = 10 * 60 * 1000;
/** How long a new credential waits for a free pool slot when every child is busy. */
export const DEFAULT_POOL_WAIT_MS = 30_000;
export const UPSTREAM_PACKAGE = "@acronis-platform/mcp";

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
export function createStdioSpawner(extraEnv: Record<string, string> = {}): Spawner {
  return async (creds, toolsInclude, ctx) => {
    // Upstream writes an (encrypted) token cache under $HOME/.mcp. Give every
    // child its own private, throwaway HOME so tenants never share a cache
    // directory; it is removed when the child closes.
    const childHome = await mkdtemp(join(tmpdir(), "acronis-tenant-"));
    await chmod(childHome, 0o700);
    const removeHome = () => rm(childHome, { recursive: true, force: true }).catch(() => undefined);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolveUpstreamBin()],
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
      await client.connect(transport);
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
  inUse: number;
  /** Removed from the map; close once inUse hits zero. */
  retired: boolean;
}

export class PoolBusyError extends Error {
  constructor() {
    super("Acronis is busy with other requests right now. Try again in a moment.");
    this.name = "PoolBusyError";
  }
}

export interface PoolOptions {
  toolsInclude: readonly string[];
  spawner?: Spawner;
  max?: number;
  idleMs?: number;
  /** Max wait for a free slot when the pool is full of busy children. */
  waitMs?: number;
  now?: () => number;
}

function intFromEnv(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function poolOptionsFromEnv(
  env: Record<string, string | undefined> = process.env
): { max: number; idleMs: number } {
  return {
    max: intFromEnv(env.ACRONIS_POOL_MAX, DEFAULT_POOL_MAX),
    idleMs: intFromEnv(env.ACRONIS_POOL_IDLE_MS, DEFAULT_POOL_IDLE_MS),
  };
}

export class UpstreamPool {
  private readonly entries = new Map<string, Entry>(); // insertion order == LRU order
  /** Retired children still serving a call; closed when their last call ends (and on shutdown). */
  private readonly draining = new Set<Entry>();
  /** Callers waiting for a free slot (every indexed child busy). */
  private waiters: Array<() => void> = [];
  private readonly waitMs: number;
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
    this.max = opts.max ?? DEFAULT_POOL_MAX;
    this.idleMs = opts.idleMs ?? DEFAULT_POOL_IDLE_MS;
    this.waitMs = opts.waitMs ?? DEFAULT_POOL_WAIT_MS;
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  /** Run fn with the child for these credentials, spawning it on first use. */
  async withConnection<T>(
    creds: AcronisCredentials,
    fn: (conn: UpstreamConnection) => Promise<T>
  ): Promise<T> {
    if (this.closed) throw new Error("Upstream pool is closed");
    this.evictIdle();
    const key = credentialKey(creds);
    const entry = await this.acquire(key, creds);
    try {
      const conn = await entry.conn;
      return await fn(conn);
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

  /**
   * Find or spawn the child for key and mark it in use. Busy children are
   * never evicted: when the pool is full and every child is busy, a new
   * credential waits for a slot (up to waitMs), then fails with PoolBusyError.
   */
  private async acquire(key: string, creds: AcronisCredentials): Promise<Entry> {
    const deadline = this.now() + this.waitMs;
    for (;;) {
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
      if (this.hasCapacity()) {
        const entry = this.create(key, creds);
        entry.inUse++;
        return entry;
      }
      const remaining = deadline - this.now();
      if (remaining <= 0) throw new PoolBusyError();
      await this.waitForSlot(remaining);
    }
  }

  /** Room for one more child, after evicting an idle one if needed. */
  private hasCapacity(): boolean {
    if (this.entries.size < this.max) return true;
    const idle = [...this.entries.values()].find((e) => e.inUse === 0);
    if (!idle) return false;
    logger.debug("Upstream child evicted (LRU)", { poolKey: idle.key.slice(0, 12) });
    this.drop(idle);
    return this.entries.size < this.max;
  }

  private waitForSlot(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      this.waiters.push(done);
    });
  }

  private wake(): void {
    const waiting = this.waiters;
    this.waiters = [];
    for (const w of waiting) w();
  }

  private create(key: string, creds: AcronisCredentials): Entry {
    const entry: Entry = {
      key,
      lastUsed: this.now(),
      inUse: 0,
      retired: false,
      conn: undefined as unknown as Promise<UpstreamConnection>,
    };
    entry.conn = this.spawner(creds, this.toolsInclude, {
      onClose: () => this.drop(entry),
    });
    entry.conn.catch(() => this.drop(entry)); // failed spawn must not poison the key
    this.entries.set(key, entry);
    logger.debug("Upstream child spawned", { poolKey: key.slice(0, 12), size: this.entries.size });
    this.startSweeper();
    return entry;
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
