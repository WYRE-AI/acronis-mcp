/**
 * Sustained-load memory regression (WYREAI-711): the pool ceiling in
 * src/upstream-pool.ts is derived from measured peaks, so the real wrapper (the
 * BUILT dist/, as the image runs it, with the Dockerfile's node flags) must stay
 * inside the container's memory under sustained load, with no child crashing.
 * scripts/sustained-load.mjs does the measuring: real HTTP server, real pool,
 * real upstream children and egress guard, a fake Acronis answering at the
 * response cap, several callers on several tenants for a few seconds, and the
 * wrapper's event loop stalled as a 0.25 vCPU container stalls it.
 *
 * Run it with `npm run test:load`; it is not part of `npm test` because it needs
 * the CPU to itself. Needs `npm run build` first (CI does). RSS differs between macOS and Linux, so
 * a failure on a new platform means "re-measure and re-size", not just "retry".
 * Set ACRONIS_SKIP_LOAD_TEST=1 to skip it (slow machines, shared CI runners).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

const repo = new URL("../../", import.meta.url).pathname;
const skip = process.env.ACRONIS_SKIP_LOAD_TEST === "1" || !existsSync(`${repo}dist/index.js`);

interface LoadResult {
  budgetMb: number;
  calls: { ok: number; rate_limited: number; error: number; http_error: number };
  perTenant: Array<{ ok: number; rate_limited: number; failed: number; worstMs: number }>;
  peak: { wrapperMb: number; childMb: number; totalMb: number; liveChildren: number };
  wrapperSurvived: boolean;
  failures: string[];
}

function load(env: Record<string, string>): LoadResult {
  const r = spawnSync(process.execPath, [`${repo}scripts/sustained-load.mjs`], {
    cwd: repo,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", LOAD_JSON: "1", ...env },
    timeout: 90_000,
  });
  const line = r.stdout.trim().split("\n").at(-1) ?? "";
  try {
    console.log(line); // the numbers, for the CI log
    return JSON.parse(line) as LoadResult;
  } catch {
    throw new Error(`sustained-load.mjs printed no result (exit ${r.status}): ${r.stdout}\n${r.stderr}`);
  }
}

describe.skipIf(skip)("sustained load stays inside the container's memory", () => {
  it("0.5 Gi: 2 tenants, 6 callers, responses at the cap: under 512 MiB in total, nothing crashes", () => {
    const r = load({ LOAD_MEMORY_MB: "512", LOAD_TENANTS: "2", LOAD_CALLERS: "6", LOAD_SECONDS: "6" });
    expect(r.failures).toEqual([]);
    expect(r.wrapperSurvived).toBe(true);
    expect(r.calls.error + r.calls.http_error).toBe(0); // a crashed child would show up here
    expect(r.calls.ok).toBeGreaterThan(0);
    expect(r.peak.totalMb).toBeLessThanOrEqual(512);
    expect(r.peak.liveChildren).toBeLessThanOrEqual(1 + 1); // the ceiling at 0.5 Gi, plus one replacement
  }, 90_000);

  it("0.5 Gi (one child): two busy tenants take turns, so both are served and nobody is refused", () => {
    // A 2 s time slice (the default is 10 s) so the tenants swap several times in 20 s.
    const r = load({ LOAD_MEMORY_MB: "512", LOAD_TENANTS: "2", LOAD_CALLERS: "6", LOAD_SECONDS: "20", LOAD_SLICE_MS: "2000" });
    expect(r.failures).toEqual([]);
    for (const tenant of r.perTenant) {
      expect(tenant.ok).toBeGreaterThan(10); // before the fix one tenant got 3 calls in 45 s
      expect(tenant.rate_limited).toBe(0);
      expect(tenant.worstMs).toBeLessThan(15_000); // a few slices, nowhere near the 30 s a caller waits at most
    }
    expect(r.peak.liveChildren).toBeLessThanOrEqual(1 + 1);
    expect(r.peak.totalMb).toBeLessThanOrEqual(512);
  }, 90_000);

  it("1 Gi: 4 tenants, 8 callers: under 1024 MiB in total, nothing crashes, every tenant served", () => {
    const r = load({ LOAD_MEMORY_MB: "1024", LOAD_TENANTS: "4", LOAD_CALLERS: "8", LOAD_SECONDS: "6" });
    expect(r.failures).toEqual([]);
    expect(r.calls.error + r.calls.http_error).toBe(0);
    expect(r.calls.rate_limited).toBe(0);
    expect(r.peak.totalMb).toBeLessThanOrEqual(1024);
    expect(r.peak.liveChildren).toBeLessThanOrEqual(4 + 1);
  }, 90_000);
});
