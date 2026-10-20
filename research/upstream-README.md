# Acronis API MCP Server

## Prerequisites

- [Node.js](https://nodejs.org/) 22 or later

## Quick Start

Configure your MCP client to run the server via `npx -y @acronis-platform/mcp` — npx downloads
and runs the published package on demand, so no manual installation or build step is
required.

Set authentication environment variables only if required by your API deployment.

#### Claude Desktop

Config file location:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Open it via **Claude menu > Settings > Developer > Edit Config**, add the server entry, then **restart Claude Desktop**.

```json
{
  "mcpServers": {
    "acronis-mcp": {
      "command": "npx",
      "args": ["-y", "@acronis-platform/mcp"],
      "env": {
        "API_BASE_URL": "https://mc-beta-cloud.acronis.com",
        "OAUTH_CLIENT_ID": "my-client",
        "OAUTH_CLIENT_SECRET": "my-secret"
      }
    }
  }
}
```

[Claude Desktop MCP setup guide](https://modelcontextprotocol.io/docs/develop/connect-local-servers)

#### GitHub Copilot (VS Code)

Create `.vscode/mcp.json` in your project root:

```json
{
  "servers": {
    "acronis-mcp": {
      "command": "npx",
      "args": ["-y", "@acronis-platform/mcp"],
      "env": {
        "API_BASE_URL": "https://mc-beta-cloud.acronis.com",
        "OAUTH_CLIENT_ID": "my-client",
        "OAUTH_CLIENT_SECRET": "my-secret"
      }
    }
  }
}
```

After saving, click **Start** in the MCP panel, then open Copilot Chat in **Agent** mode to use the tools.

[GitHub Copilot MCP setup guide](https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/extend-copilot-chat-with-mcp)

#### Devin

Add to `.devin/config.json` (team-wide) or `.devin/config.local.json` (personal, gitignored):

```json
{
  "mcpServers": {
    "acronis-mcp": {
      "command": "npx",
      "args": ["-y", "@acronis-platform/mcp"],
      "env": {
        "API_BASE_URL": "https://mc-beta-cloud.acronis.com",
        "OAUTH_CLIENT_ID": "my-client",
        "OAUTH_CLIENT_SECRET": "my-secret"
      }
    }
  }
}
```

Or register via the CLI (no environment variables; edit the config file afterward to add `env`):

```bash
devin mcp add acronis-mcp -- npx -y @acronis-platform/mcp
```

[Devin MCP configuration guide](https://docs.devin.ai/cli/extensibility/mcp/configuration)

## HTTP transport

```bash
API_BASE_URL=https://api.example.com \
OAUTH_CLIENT_ID=my-client \
OAUTH_CLIENT_SECRET=my-secret \
MCP_TRANSPORT=http \
MCP_BEARER_TOKEN=shared-secret \
npm run start:http
```

> **Security:** when `client_credentials` is configured (`OAUTH_CLIENT_ID`/`OAUTH_CLIENT_SECRET`),
> the server holds a privileged upstream token and reuses it for every caller. `MCP_BEARER_TOKEN`
> is therefore **required** in HTTP mode with `client_credentials` — the server refuses to start
> without it so the token is never exposed to unauthenticated callers.

## Dynamic mode

Instead of registering all tools upfront, expose two meta-tools — `_list_api_endpoints`
and `_enable_api_endpoints` — and let the client activate endpoints on demand:

```bash
MCP_DYNAMIC_TOOLS=true npm start
```

## Environment variables

### General

| Variable | Default | Description |
|---|---|---|
| `API_BASE_URL` | `https://mc-beta-cloud.acronis.com` | Upstream API base URL. May include a path prefix (e.g. `https://api.example.com/api/v2`). |
| `MCP_TRANSPORT` | `stdio` | Transport: `stdio` or `http` |
| `MCP_INSTRUCTIONS` | _(baked default)_ | Usage instructions sent to MCP clients, overriding the built-in default |
| `MCP_INSECURE` | `false` | Set to `true` to skip TLS certificate verification (dev/testing only) |
| `MCP_VERBOSE` | `false` | Set to `true` to log forwarded request URLs and response status to stderr |

### Tools

| Variable | Default | Description |
|---|---|---|
| `MCP_TOOLS_INCLUDE` | _(all)_ | Comma-separated list of tool name patterns to expose. Supports `*` wildcards (e.g. `get_*,list_*`). Applied before `MCP_TOOLS_EXCLUDE`. |
| `MCP_TOOLS_EXCLUDE` | _(none)_ | Comma-separated list of tool name patterns to hide. Applied after `MCP_TOOLS_INCLUDE`. |

### Authentication

| Variable | Default | Description |
|---|---|---|
| `OAUTH_TOKEN_URL` | `/api/2/idp/token` | OAuth token endpoint for `client_credentials` flow. An absolute URL (e.g. `https://…/token`) is used as-is; an absolute path (e.g. `/api/2/idp/token`) is resolved relative to `API_BASE_URL`. |
| `OAUTH_CLIENT_ID` | — | OAuth client ID |
| `OAUTH_CLIENT_SECRET` | — | OAuth client secret |
| `OAUTH_SCOPES` | — | Comma-separated OAuth scopes (optional) |

### HTTP transport

| Variable | Default | Description |
|---|---|---|
| `MCP_HTTP_PORT` | `3000` | Port to listen on |
| `MCP_HTTP_HOST` | `127.0.0.1` | Host to bind to |
| `MCP_HTTP_ENDPOINT` | `/mcp` | Path to mount the MCP endpoint on |
| `MCP_BEARER_TOKEN` | — | Shared secret MCP clients must present to connect |

### Dynamic mode

| Variable | Default | Description |
|---|---|---|
| `MCP_DYNAMIC_TOOLS` | `false` | Enable dynamic tool discovery |
| `MCP_MAX_TOOLS_ENABLED` | `25` | Max simultaneously active tools (0 = unlimited) |
| `MCP_MAX_TOOL_RESULTS` | `10` | Max results from `_list_api_endpoints` (0 = unlimited) |
