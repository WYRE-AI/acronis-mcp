/**
 * Supply-chain pin (WYREAI-711): scripts/verify-upstream.mjs must pass on the
 * real install and fail on every kind of drift. CI and the Dockerfile run the
 * same script, so a changed bundle, lock entry or version fails the build.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repo = new URL("../../", import.meta.url).pathname;
const script = join(repo, "scripts/verify-upstream.mjs");
const pin = JSON.parse(readFileSync(join(repo, "scripts/upstream-pin.json"), "utf8")) as {
  package: string;
  version: string;
  tarballIntegrity: string;
};
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

const run = (root: string) => spawnSync(process.execPath, [script, root], { encoding: "utf8" });

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A minimal copy of the install the script looks at: package.json, lock entry, bundle. */
function fixtureRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "acronis-pin-"));
  scratch.push(dir);
  const pkgDir = join(dir, "node_modules", pin.package);
  mkdirSync(join(pkgDir, "dist"), { recursive: true });
  cpSync(join(repo, "package.json"), join(dir, "package.json"));
  cpSync(join(repo, "package-lock.json"), join(dir, "package-lock.json"));
  cpSync(join(repo, "node_modules", pin.package, "package.json"), join(pkgDir, "package.json"));
  cpSync(join(repo, "node_modules", pin.package, "dist/bundle.js"), join(pkgDir, "dist/bundle.js"));
  return dir;
}

describe("upstream bump needs a human", () => {
  it("tells Dependabot to ignore the upstream package, so no bump PR exists to auto-merge", () => {
    const dependabot = readFileSync(join(repo, ".github/dependabot.yml"), "utf8");
    expect(dependabot).toMatch(/ignore:[\s\S]*- dependency-name: "@acronis-platform\/mcp"/);
  });

  it("has no auto-merge workflow", () => {
    const workflows = readdirSync(join(repo, ".github/workflows")).map((f) => readFileSync(join(repo, ".github/workflows", f), "utf8"));
    for (const text of workflows) expect(text).not.toMatch(/auto-?merge|gh pr merge/i);
  });

  it("requires a code owner for everything that selects or changes the upstream bundle", () => {
    const owners = readFileSync(join(repo, ".github/CODEOWNERS"), "utf8");
    for (const path of ["/package.json", "/package-lock.json", "/scripts/upstream-pin.json", "/Dockerfile", "/child-egress-guard.cjs"]) {
      expect(owners).toMatch(new RegExp(`^${path.replace(/[.]/g, "\\.")}\\s+@\\S+`, "m"));
    }
  });
});

describe("upstream pin check", () => {
  it("passes on the real install", () => {
    const r = run(repo);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`${pin.package}@${pin.version}`);
  });

  it("fails when the bundle's sha256 differs (a tampered or republished bundle)", () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "node_modules", pin.package, "dist/bundle.js"), "console.log('not the pinned bundle');\n");
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("sha256 of @acronis-platform/mcp/dist/bundle.js");
  });

  it("fails when the lockfile resolves a different tarball", () => {
    const root = fixtureRoot();
    const lock = readJson(join(root, "package-lock.json"));
    lock.packages[`node_modules/${pin.package}`].integrity = "sha512-AAAA" + pin.tarballIntegrity.slice(10);
    writeFileSync(join(root, "package-lock.json"), JSON.stringify(lock));
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("package-lock integrity");
  });

  it("fails when package.json moves to another version without a human updating the pin", () => {
    const root = fixtureRoot();
    const pkg = readJson(join(root, "package.json"));
    pkg.dependencies[pin.package] = "^1.0.2";
    writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("package.json dependency");
    expect(r.stderr).toContain("human diff");
  });

  it("fails when the installed package is another version", () => {
    const root = fixtureRoot();
    const installed = join(root, "node_modules", pin.package, "package.json");
    writeFileSync(installed, JSON.stringify({ ...readJson(installed), version: "1.0.2" }));
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("installed version");
  });
});
