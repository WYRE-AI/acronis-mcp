#!/usr/bin/env node
// MCP Stdio Guard — MUST be the bin entry point. Redirects console.log, .info and .debug to
// stderr before any library code loads, preventing stdout pollution from
// corrupting the MCP JSON-RPC stdio channel.
if (!process.env.MCP_TRANSPORT || process.env.MCP_TRANSPORT === "stdio") {
  const toStderr = (...args: unknown[]) => {
    process.stderr.write(
      args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ") + "\n"
    );
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
}
// Dynamic import ensures the guard is active before module resolution.
import("./index.js").catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
