// Test fixture, preloaded into a real upstream child (`NODE_OPTIONS=--require`).
// Writes what the child process actually received (pid, argv, env) to
// $ACRONIS_TEST_RECORD_DIR/<pid>.json, so a test can inspect the real process
// instead of trusting the code that builds its environment.
"use strict";
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");

const dir = process.env.ACRONIS_TEST_RECORD_DIR;
if (dir) {
  writeFileSync(
    join(dir, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, argv: process.argv, env: process.env })
  );
}
