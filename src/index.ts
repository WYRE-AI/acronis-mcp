#!/usr/bin/env node
/**
 * Acronis Cyber Protect Cloud MCP wrapper — 34 read tools (+3 gated writes)
 * proxied to the pinned upstream @acronis-platform/mcp, one child per tenant.
 *
 * Transports:
 * - stdio (default): local Claude Desktop / CLI usage. `serveStdio` owns the
 *   era decision: a 2025-era `initialize` pins the connection legacy; modern
 *   2026-07-28 envelope openings are served natively. stdio does not use
 *   service-to-service auth.
 * - http: hosted deployment. `createMcpHandler({ legacy: 'stateless' })` is
 *   the dual-era posture — 2025-era traffic answered per-request statelessly,
 *   modern envelope traffic natively. NEVER `legacy: 'reject'`.
 *
 * HTTP refuses to start unless CONDUIT_S2S_SECRET is a real secret. Known
 * placeholder values are rejected. MCP_ALLOW_INSECURE_DEV=1 is a local-only
 * escape hatch for an empty secret: it logs a warning, skips X-Gateway-S2S,
 * and binds 127.0.0.1 only. A configured secret honors MCP_HTTP_HOST.
 * The listen address defaults to 127.0.0.1. /health and /healthz stay
 * unauthenticated and do not read credentials.
 *
 * Credentials via environment variable (env mode):
 * - ACRONIS_BASE_URL, ACRONIS_CLIENT_ID, ACRONIS_CLIENT_SECRET
 * Or via gateway headers (AUTH_MODE=gateway):
 * - X-Acronis-Base-Url, X-Acronis-Client-Id, X-Acronis-Client-Secret
 * Gateway mode never falls back to the ACRONIS_* environment variables.
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  GATEWAY_HEADERS,
  SERVER_VERSION,
  createMcpServer,
  createPool,
  makeMcpServerFactory,
  type ServerDeps,
  resolveEnvCredentials,
  resolveGatewayCredentials,
} from "./mcp-server.js";
import { S2S_HEADER, verifyS2sHeader } from "./s2s-verify.js";
import { logger } from "./utils/logger.js";

const CORS_ALLOW_HEADERS = [
  "Content-Type",
  "Accept",
  "Authorization",
  "Mcp-Session-Id",
  "Mcp-Protocol-Version",
  "X-Gateway-S2S",
  ...GATEWAY_HEADERS,
].join(", ");

const LOOPBACK_HOST = "127.0.0.1";

/** Production shutdown awaits this before closing the listener. */
let closeActiveMcp: (() => Promise<void>) | undefined;
/** Closed on shutdown so no upstream child outlives the wrapper. */
let activeDeps: ServerDeps | undefined;

/**
 * Public example values. A copied placeholder must not verify as a real
 * service-to-service secret (anyone who can read the example could sign).
 */
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  "replace-with-a-real-secret",
  "your-s2s-secret",
  "your-secret",
  "changeme",
  "change-me",
  "placeholder",
  "secret",
  "example",
  "replace-me",
  "s2s-secret",
]);

function headerValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isKnownPlaceholderSecret(secret: string): boolean {
  return KNOWN_PLACEHOLDER_SECRETS.has(secret.toLowerCase());
}

/**
 * Secret for X-Gateway-S2S on /mcp. Read at HTTP startup, not module load.
 * Empty fails closed unless MCP_ALLOW_INSECURE_DEV=1. A known placeholder
 * always refuses to start, including when that flag is set. The secret
 * value is never written to logs.
 */
function resolveHttpS2sSecret(): string {
  const secret = (process.env.CONDUIT_S2S_SECRET ?? "").trim();
  if (isKnownPlaceholderSecret(secret)) {
    logger.error(
      "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is a known placeholder. " +
        "Generate a secret with `openssl rand -hex 32` and set CONDUIT_S2S_SECRET to that value."
    );
    process.exit(1);
  }
  if (secret) return secret;

  if (process.env.MCP_ALLOW_INSECURE_DEV === "1") {
    logger.error(
      "SECURITY WARNING: CONDUIT_S2S_SECRET is empty and MCP_ALLOW_INSECURE_DEV=1. " +
        "HTTP /mcp is not enforcing X-Gateway-S2S and is bound to 127.0.0.1 only. " +
        "Do not use this outside local development."
    );
    return "";
  }

  logger.error(
    "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is empty. " +
      "Set CONDUIT_S2S_SECRET, or set MCP_ALLOW_INSECURE_DEV=1 for local development only."
  );
  process.exit(1);
}

/**
 * No secret (insecure-dev bypass only): always 127.0.0.1, ignoring a wider
 * MCP_HTTP_HOST. A configured secret honors MCP_HTTP_HOST. When that variable
 * is unset, bind 127.0.0.1. The container image sets MCP_HTTP_HOST=0.0.0.0.
 */
function resolveHttpBindHost(hasRealSecret: boolean): string {
  const configured = (process.env.MCP_HTTP_HOST ?? "").trim();
  if (hasRealSecret) return configured || LOOPBACK_HOST;
  if (configured && configured !== LOOPBACK_HOST) {
    logger.error(
      `MCP_HTTP_HOST=${configured} is not used without a real CONDUIT_S2S_SECRET. ` +
        "MCP_ALLOW_INSECURE_DEV=1 binds 127.0.0.1 only."
    );
  }
  return LOOPBACK_HOST;
}

/** stdio (default). Fresh server per process; env-mode credentials. */
function startStdioTransport(): void {
  const deps = createPool();
  activeDeps = deps;
  const { credentials, error } = resolveEnvCredentials();
  if (error) logger.warn("No usable env credentials; tools/call will be refused", { reason: error });
  serveStdio(() => createMcpServer(deps, credentials), {
    onerror: (err) => logger.error("stdio serving error", { error: err.message }),
  });
  logger.info("Acronis MCP server running on stdio");
}

export async function startHttpTransport(): Promise<HttpServer> {
  const port = parseInt(process.env.MCP_HTTP_PORT || "8080", 10);
  const s2sSecret = resolveHttpS2sSecret();
  const host = resolveHttpBindHost(Boolean(s2sSecret));
  const isGatewayMode = process.env.AUTH_MODE === "gateway";

  const deps = createPool();
  activeDeps = deps;
  const mcpHandler = createMcpHandler(makeMcpServerFactory({ gatewayMode: isGatewayMode }, deps), {
    legacy: "stateless",
    onerror: (error) => logger.error("MCP serving error", { error: error.message }),
  });
  const handleMcpRequest = toNodeHandler(mcpHandler, {
    onerror: (error) => logger.error("MCP request adapter error", { error: error.message }),
  });

  const handleHttp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // CORS for claude.ai custom connectors — set on every response, before routing.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
    res.setHeader("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
    res.setHeader("Access-Control-Max-Age", "86400");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Constant base: only the path is used, and a client-supplied Host header
    // must never be able to make URL parsing throw.
    let url: URL;
    try {
      url = new URL(req.url || "/", "http://localhost");
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Bad request" }));
      return;
    }

    // Health endpoint — shallow, unauthenticated liveness probe. Must NOT
    // touch credentials or any upstream: in gateway mode credentials only
    // arrive per-request via headers, so a credential check here would
    // always fail and crash-loop the container.
    if (url.pathname === "/health" || url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          version: SERVER_VERSION,
          mcpTransport: "http",
          authMode: isGatewayMode ? "gateway" : "env",
          timestamp: new Date().toISOString(),
        })
      );
      return;
    }

    if (url.pathname === "/mcp") {
      // S2S gate: reject any request not signed by the conduit gateway
      // BEFORE any other processing — closes the confused-deputy gap where
      // a compromised sibling sidecar could otherwise impersonate the
      // gateway to this container. An empty secret is only reachable when
      // MCP_ALLOW_INSECURE_DEV=1; startup refuses otherwise. A configured
      // secret is always enforced.
      if (s2sSecret && !verifyS2sHeader(headerValue(req.headers[S2S_HEADER]), s2sSecret)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32001,
              message:
                "Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.",
            },
            id: null,
          })
        );
        return;
      }

      // 401 gate: reject unauthenticated gateway traffic BEFORE serving —
      // falling through to env-configured credentials would serve the
      // operator's tenant data to whoever asked (cross-tenant leak).
      if (isGatewayMode) {
        const { error } = resolveGatewayCredentials((name) => headerValue(req.headers[name]));
        if (error) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32001,
                message: `Unauthorized: ${error}`,
                data: { required: GATEWAY_HEADERS },
              },
              id: null,
            })
          );
          return;
        }
      }

      // Per-request credential binding happens inside the factory (it reads
      // the gateway header from ctx.requestInfo on every request).
      await handleMcpRequest(req, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found", endpoints: ["/mcp", "/health"] }));
  };

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    // A throw inside the handler must answer 500, never crash the process.
    handleHttp(req, res).catch((err: unknown) => {
      logger.error("HTTP handler error", { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      } else {
        res.destroy();
      }
    });
  });

  let mcpClosed = false;
  const closeMcp = async () => {
    if (mcpClosed) return;
    mcpClosed = true;
    await mcpHandler.close();
    await deps.pool.close();
  };
  closeActiveMcp = closeMcp;
  httpServer.on("close", () => {
    void closeMcp();
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    httpServer.once("error", onError);
    httpServer.listen(port, host, () => {
      httpServer.off("error", onError);
      logger.info(`Acronis MCP server listening on http://${host}:${port}/mcp`);
      logger.info(`Health check available at http://${host}:${port}/health`);
      logger.info(`Authentication mode: ${isGatewayMode ? "gateway (header-based)" : "env"}`);
      resolve();
    });
  });

  return httpServer;
}

async function main() {
  const transportType = process.env.MCP_TRANSPORT || "stdio";
  logger.info("Starting Acronis MCP server", {
    transport: transportType,
    nodeVersion: process.version,
  });

  if (transportType === "http") {
    const httpServer = await startHttpTransport();
    const shutdown = async () => {
      logger.info("Shutting down Acronis MCP server...");
      if (closeActiveMcp) await closeActiveMcp();
      if (activeDeps) await activeDeps.pool.close();
      if (httpServer.listening) {
        await new Promise<void>((resolve, reject) => {
          httpServer.close((err) => (err ? reject(err) : resolve()));
        });
      }
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } else {
    startStdioTransport();
    const shutdown = async () => {
      if (activeDeps) await activeDeps.pool.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }
}

// Vitest imports this module to call startHttpTransport. Skip the CLI
// entrypoint there. `node dist/index.js` still starts stdio or HTTP.
if (process.env.VITEST !== "true") {
  main().catch((error) => {
    logger.error("Fatal startup error", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
}
