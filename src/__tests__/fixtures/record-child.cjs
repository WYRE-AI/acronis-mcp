// Test fixture, preloaded into a real upstream child (`NODE_OPTIONS=--require`).
// Writes what the child process actually received (pid, argv, execArgv, env) to
// $ACRONIS_TEST_RECORD_DIR/<pid>.json, so a test can inspect the real process
// instead of trusting the code that builds its environment.
//
// With ACRONIS_TEST_HOG=1 the child also exhausts its own heap on SIGUSR2, to
// show that the --max-old-space-size cap kills only that child.
"use strict";
const { renameSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const dir = process.env.ACRONIS_TEST_RECORD_DIR;
if (dir) {
  // Write to a temp name and rename, so a reader never sees a half-written file.
  const file = join(dir, `${process.pid}.json`);
  writeFileSync(file + ".tmp", JSON.stringify({ pid: process.pid, argv: process.argv, execArgv: process.execArgv, env: process.env }));
  renameSync(file + ".tmp", file);
}

// With ACRONIS_TEST_IMMORTAL=1 the child ignores SIGTERM and stays alive after stdin
// closes, so only SIGKILL stops it: the pool's close must escalate that far.
if (process.env.ACRONIS_TEST_IMMORTAL === "1") {
  process.on("SIGTERM", () => undefined);
  setInterval(() => undefined, 1000);
}

if (process.env.ACRONIS_TEST_HOG === "1") {
  process.on("SIGUSR2", () => {
    const keep = [];
    for (;;) keep.push(Array.from({ length: 10_000 }, () => ({ n: Math.random() })));
  });
}
