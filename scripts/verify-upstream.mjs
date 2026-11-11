#!/usr/bin/env node
// Verifies the pinned upstream package (WYREAI-711). The upstream
// @acronis-platform/mcp has no source repo and no provenance and ships as one
// esbuild bundle, so dependency scanners cannot see inside it. This pins what
// we run, byte for byte, and fails the build or CI on any difference:
//
//   1. package.json depends on exactly the pinned version,
//   2. package-lock.json resolves that version to the pinned tarball integrity
//      (npm ci then refuses a tarball that does not match it),
//   3. the installed package is that version,
//   4. the files the package runs are exactly the pinned ones (bin/ and dist/:
//      none added, none missing) and each has the pinned sha256, and
//   5. the package's bin entry, which is what the pool executes
//      (resolveUpstreamBin in src/upstream-pool.ts), is one of those files.
//
// Run: node scripts/verify-upstream.mjs [rootDir]   (default: the repo root)
// Used by `npm run verify-upstream`, CI (test.yml) and the Dockerfile, which
// runs it after `npm prune` so it checks the node_modules that ships.
// To bump the upstream, a human updates scripts/upstream-pin.json after
// diffing the new bundle against the old one (see README "Upstream pinning").
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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

const installed = readJson(join(installedDir, "package.json"));
expect("installed version", installed.version, pin.version);

// Every file the package can run: all of bin/ and dist/, as package-relative paths.
const present = ["bin", "dist"]
  .filter((dir) => existsSync(join(installedDir, dir)))
  .flatMap((dir) =>
    readdirSync(join(installedDir, dir), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(installedDir, join(entry.parentPath, entry.name)).split("\\").join("/"))
  );
const pinned = Object.keys(pin.files);
for (const file of present) if (!pinned.includes(file)) problems.push(`unpinned file in the package: ${file}`);

const digests = [];
for (const file of pinned) {
  const path = join(installedDir, file);
  const sha256 = existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "missing";
  expect(`sha256 of ${pin.package}/${file}`, sha256, pin.files[file]);
  digests.push(`${file} ${sha256}`);
}

const bins = typeof installed.bin === "string" ? [installed.bin] : Object.values(installed.bin ?? {});
for (const target of bins) {
  if (!pinned.includes(target.replace(/^\.\//, ""))) problems.push(`bin entry ${target} is not a pinned file`);
}

if (problems.length > 0) {
  console.error(`Upstream pin check FAILED for ${pin.package}@${pin.version}:`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error("A version bump needs a human diff of the new bundle, then an update of scripts/upstream-pin.json.");
  process.exit(1);
}
console.log(`Upstream pin OK: ${pin.package}@${pin.version}\n  ${digests.join("\n  ")}`);
