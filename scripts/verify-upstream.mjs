#!/usr/bin/env node
// Verifies the pinned upstream package (WYREAI-711). The upstream
// @acronis-platform/mcp has no source repo and no provenance and ships as one
// esbuild bundle, so dependency scanners cannot see inside it. This pins what
// we run, byte for byte, and fails the build or CI on any difference:
//
//   1. package.json depends on exactly the pinned version,
//   2. package-lock.json resolves that version to the pinned tarball integrity
//      (npm ci then refuses a tarball that does not match it),
//   3. the installed package is that version, and
//   4. the sha256 of the installed bundle is the pinned one.
//
// Run: node scripts/verify-upstream.mjs [rootDir]   (default: the repo root)
// Used by `npm run verify-upstream`, CI (test.yml) and the Dockerfile.
// To bump the upstream, a human updates scripts/upstream-pin.json after
// diffing the new bundle against the old one (see README "Upstream pinning").
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const pin = readJson(join(dirname(fileURLToPath(import.meta.url)), "upstream-pin.json"));

const problems = [];
const expect = (what, actual, wanted) => {
  if (actual !== wanted) problems.push(`${what}: expected ${wanted}, found ${actual}`);
};

const installedDir = join(root, "node_modules", pin.package);
expect("package.json dependency", readJson(join(root, "package.json")).dependencies?.[pin.package], pin.version);

const locked = readJson(join(root, "package-lock.json")).packages?.[`node_modules/${pin.package}`] ?? {};
expect("package-lock version", locked.version, pin.version);
expect("package-lock integrity", locked.integrity, pin.tarballIntegrity);

expect("installed version", readJson(join(installedDir, "package.json")).version, pin.version);
const bundleSha256 = createHash("sha256").update(readFileSync(join(installedDir, pin.bundle))).digest("hex");
expect(`sha256 of ${pin.package}/${pin.bundle}`, bundleSha256, pin.bundleSha256);

if (problems.length > 0) {
  console.error(`Upstream pin check FAILED for ${pin.package}@${pin.version}:`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error("A version bump needs a human diff of the new bundle, then an update of scripts/upstream-pin.json.");
  process.exit(1);
}
console.log(`Upstream pin OK: ${pin.package}@${pin.version}, ${pin.bundle} sha256 ${bundleSha256}`);
