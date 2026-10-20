/**
 * Shared MCP server factory for the Acronis Cyber Protect Cloud wrapper.
 *
 * Side-effect free (importing never starts a transport or a child process).
 * One factory serves BOTH protocol eras via the v2 SDK serving entries.
 *
 * `tools/list` is static: it comes from src/generated/tools.ts and never
 * touches credentials or the upstream child. Only `tools/call` resolves the
 * per-tenant child from the pool.
 */
import { Server } from "@modelcontextprotocol/server";
import type { McpServerFactory } from "@modelcontextprotocol/server";
import {
  GATEWAY_HEADERS,
  resolveEnvCredentials,
  resolveGatewayCredentials,
  type AcronisCredentials,
} from "./credentials.js";
import { errorResult, sanitizeToolResult } from "./sanitize.js";
import { exposedTools, resolveUpstreamName, upstreamAllowlist, writesEnabled } from "./tiers.js";
import { UpstreamPool, poolOptionsFromEnv } from "./upstream-pool.js";
import { logger } from "./utils/logger.js";

export const SERVER_NAME = "acronis-mcp";
export const SERVER_VERSION = "1.0.0";

export { GATEWAY_HEADERS, resolveEnvCredentials, resolveGatewayCredentials };

export interface ServerDeps {
  pool: UpstreamPool;
  writes: boolean;
  /** True when credentials come from gateway headers (AUTH_MODE=gateway). Picks the user-facing error copy. */
  gatewayMode?: boolean;
}

/** Build the process-wide pool for the current environment. */
export function createPool(env: Record<string, string | undefined> = process.env): ServerDeps {
  const writes = writesEnabled(env);
  const pool = new UpstreamPool({ toolsInclude: upstreamAllowlist(writes), ...poolOptionsFromEnv(env) });
  return { pool, writes };
}

/**
 * Bind createMcpServer into the McpServerFactory shape consumed by
 * createMcpHandler. Runs once per HTTP request. In gateway mode credentials
 * come ONLY from the request headers (never env); the HTTP layer already
 * answered 401 for missing/invalid ones, and this factory never throws.
 */
export function makeMcpServerFactory(
  options: { gatewayMode: boolean },
  deps: ServerDeps
): McpServerFactory {
  return (ctx) => {
    if (options.gatewayMode) {
      const { credentials } = resolveGatewayCredentials(
        (name) => ctx.requestInfo?.headers.get(name) ?? undefined
      );
      return createMcpServer({ ...deps, gatewayMode: true }, credentials);
    }
    return createMcpServer(deps, resolveEnvCredentials().credentials);
  };
}

export function listToolsResult(writes: boolean) {
  // By reference, never rebuilt — deterministic for every caller.
  return { tools: exposedTools(writes) };
}

export async function handleToolCall(
  deps: ServerDeps,
  credentials: AcronisCredentials | undefined,
  name: unknown,
  args: unknown
) {
  // Second enforcement layer (the child also gets MCP_TOOLS_INCLUDE).
  const upstreamName = resolveUpstreamName(name, deps.writes);
  if (!upstreamName) {
    return errorResult("tool_not_found", "This Acronis tool isn't available. It may be turned off for this connection.");
  }
  if (!credentials) {
    return errorResult(
      "missing_credentials",
      deps.gatewayMode
        ? "Acronis isn't connected for this organization. An admin can connect it in Conduit under Connections."
        : "Missing Acronis credentials. Set ACRONIS_BASE_URL, ACRONIS_CLIENT_ID and ACRONIS_CLIENT_SECRET."
    );
  }
  const secrets = [credentials.clientSecret, credentials.clientId];
  try {
    const result = await deps.pool.withConnection(credentials, (conn) =>
      conn.callTool(upstreamName, (args && typeof args === "object" ? args : {}) as Record<string, unknown>)
    );
    return sanitizeToolResult(result, secrets);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Upstream call failed", { tool: upstreamName });
    return errorResult("upstream_unavailable", message, secrets);
  }
}

/** Fresh MCP server. Credentials may be absent: tools/list still works. */
export function createMcpServer(deps: ServerDeps, credentials?: AcronisCredentials): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler("tools/list", async () => listToolsResult(deps.writes));

  server.setRequestHandler("tools/call", async (request) => {
    const { name, arguments: args } = request.params;
    logger.debug("Tool call received", { tool: name });
    return handleToolCall(deps, credentials, name, args);
  });

  return server;
}
