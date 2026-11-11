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
 * Needs `npm run build` first (CI does). RSS differs between macOS and Linux, so
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

  it("1 Gi: 4 tenants, 8 callers: under 1024 MiB in total, nothing crashes, every tenant served", () => {
    const r = load({ LOAD_MEMORY_MB: "1024", LOAD_TENANTS: "4", LOAD_CALLERS: "8", LOAD_SECONDS: "6" });
    expect(r.failures).toEqual([]);
    expect(r.calls.error + r.calls.http_error).toBe(0);
    expect(r.calls.rate_limited).toBe(0);
    expect(r.peak.totalMb).toBeLessThanOrEqual(1024);
    expect(r.peak.liveChildren).toBeLessThanOrEqual(4 + 1);
  }, 90_000);
});
