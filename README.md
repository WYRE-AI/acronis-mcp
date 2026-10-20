# acronis-mcp

WYRE-AI hosted wrapper around the vendor's own MCP server for **Acronis Cyber Protect Cloud**
([`@acronis-platform/mcp`](https://www.npmjs.com/package/@acronis-platform/mcp), pinned to the
exact version **`1.0.1`**). The wrapper adds what the upstream server does not have:

- a curated, tiered tool allowlist (34 read tools, 3 opt-in write tools out of upstream's 159),
- per-tenant process isolation, hosted dual-era HTTP serving (2025-era `initialize` handshake and
  2026-07-28 stateless envelope), and `X-Gateway-S2S` verification,
- response sanitising (size cap, secret/token redaction, uniform error shape),
- an SSRF guard on the Acronis base URL (WYREAI-454).

`tools/list` is static (generated at build time), so it works without credentials and without
starting any child process. Only `tools/call` starts an upstream child.

## Upstream pinning policy

`@acronis-platform/mcp` is pinned to an **exact** version in `package.json` (no `^`/`~`; a test
enforces `1.0.1`). Bumps happen **by pull request only**. Renovate/Dependabot may propose one, but it
must not auto-merge: a bump needs a human to

1. diff the upstream `tools/list` against `research/upstream-tools-1.0.1.json` (new, renamed or
   duplicated tools),
2. regenerate `src/generated/tools.ts` with `npm run gen-tools`,
3. re-review `research/tiers.json` and the integration test.

Upstream 1.0.1 ships three duplicated tool names (`device_authorization_approval`,
`fetch_registration_tokens`, `create_registration_token`); none are allowlisted, and the generator
refuses any allowlisted name that is missing or duplicated upstream.

## Why one child process per tenant

One upstream process holds **one privileged `client_credentials` token** and uses it for every caller.
Sharing a process between tenants would let one tenant's request run with another tenant's token.
So `src/upstream-pool.ts` spawns **one child per distinct credential tuple**
(key = `sha256(baseUrl, clientId, clientSecret)`; raw values are never logged) over stdio, using
`@modelcontextprotocol/client`, and routes each call to its own tenant's child.

- Child binary: `require.resolve('@acronis-platform/mcp/package.json')` → `bin/cli.js`, run with
  `process.execPath`.
- Child environment is built from scratch (the parent env is **not** inherited, so
  `CONDUIT_S2S_SECRET` etc. cannot leak): `PATH`, `NODE_ENV`, `API_BASE_URL`, `OAUTH_CLIENT_ID`,
  `OAUTH_CLIENT_SECRET`, `MCP_TRANSPORT=stdio`, `MCP_TOOLS_INCLUDE=<allowlist for enabled tiers>`.
  (The MCP client SDK additionally adds its own non-secret defaults: `HOME`, `LOGNAME`, `SHELL`,
  `TERM`, `USER`.)
- LRU limit `ACRONIS_POOL_MAX` (default 50), idle TTL `ACRONIS_POOL_IDLE_MS` (default 10 min), and
  every child is closed on shutdown. An evicted child that is mid-call is closed when the call ends.

Known upstream behaviours to be aware of:

- Upstream 1.0.1 **fetches an OAuth token eagerly at startup**, so a child with bad credentials (or
  no route to the datacenter) exits immediately. The caller then gets an
  `{error:{code:"upstream_unavailable",…}}` result; the first call per tenant pays the token round trip.
- Each tenant child runs with its own private, throwaway `HOME` (mkdtemp, mode 0700, removed when the child exits), so the upstream token cache below is never shared between tenants.
- Upstream caches the access token on disk under `~/.mcp/token-cache` (mode 0600, AES-256-GCM,
  keyed from the client secret).
- Upstream registers an extra built-in tool, `get_acronis_skill`, that is **not** filtered by
  `MCP_TOOLS_INCLUDE`. The wrapper never lists or forwards it (the allowlist is enforced a second time
  in the call handler).

## Tools

Tool names are `acronis_` + the upstream name. A tool that is not in `research/tiers.json` is never
listed and never callable. This is enforced twice: `MCP_TOOLS_INCLUDE` on the child, and an allowlist
check in our `tools/call` handler.

- **read** tools are always available (`readOnlyHint: true`).
- **write** tools appear and work only when `ACRONIS_ENABLE_WRITES=true` (default `false`);
  annotated `readOnlyHint: false`, `destructiveHint: false`.

Input schemas are taken verbatim from upstream. Because 37 tools exceeds the fleet's ~25 flat-tool
threshold, descriptions are cut to the first sentence (max 300 chars) with the
`[Account Management API 2]`-style prefix removed. Tool definitions live in
`src/generated/tools.ts`, produced by `scripts/gen-tools.mjs` (`npm run gen-tools`) from
`research/upstream-tools-1.0.1.json` filtered by `research/tiers.json`.

`tools/list` payload size (JSON bytes):

| Surface | Before (upstream, full) | After (wrapper) |
|---|---|---|
| Upstream, all 159 tools | 298,320 | n/a (not exposed) |
| 34 read tools | 70,343 | 67,309 |
| 37 tools (reads + writes) | 75,822 | 72,864 |

(Schemas dominate the payload and are kept from upstream, so description trimming saves ~5%.)

| Tool | Tier | Upstream API |
|---|---|---|
| `acronis_fetch_tenant` | read | Account Management API 2 |
| `acronis_fetch_tenants_batch` | read | Account Management API 2 |
| `acronis_fetch_tenant_children` | read | Account Management API 2 |
| `acronis_fetch_tenant_users` | read | Account Management API 2 |
| `acronis_fetch_users_batch` | read | Account Management API 2 |
| `acronis_fetch_user` | read | Account Management API 2 |
| `acronis_fetch_current_user_info` | read | Account Management API 2 |
| `acronis_search` | read | Account Management API 2 |
| `acronis_fetch_tenant_mfa_status` | read | Account Management API 2 |
| `acronis_fetch_tenant_usages` | read | Account Management API 2 |
| `acronis_fetch_all_alerts` | read | Alert Manager 1.0 |
| `acronis_fetch_alert` | read | Alert Manager 1.0 |
| `acronis_fetch_categories` | read | Alert Manager 1.0 |
| `acronis_fetch_alert_counters` | read | Alert Manager 1.0 |
| `acronis_fetch_alerts_grouped_by_scope` | read | Alert Manager 1.0 |
| `acronis_fetch_all_alert_types` | read | Alert Manager 1.0 |
| `acronis_fetch_resources_with_top_severity_alerts` | read | Alert Manager 1.0 |
| `acronis_fetch_alert_counts_per_customer` | read | Alert Manager 1.0 |
| `acronis_fetch_alerts_grouped_per_customer` | read | Alert Manager 1.0 |
| `acronis_fetch_active_alert_count` | read | Alert Manager 1.0 |
| `acronis_fetch_policies` | read | Resource and Policy Management API v4 |
| `acronis_fetch_policy` | read | Resource and Policy Management API v4 |
| `acronis_fetch_policy_applications` | read | Resource and Policy Management API v4 |
| `acronis_fetch_applications_issue_statistics` | read | Resource and Policy Management API v4 |
| `acronis_fetch_application_statuses_by_policy` | read | Resource and Policy Management API v4 |
| `acronis_fetch_resources` | read | Resource and Policy Management API v4 |
| `acronis_fetch_resource_count` | read | Resource and Policy Management API v4 |
| `acronis_fetch_resource` | read | Resource and Policy Management API v4 |
| `acronis_fetch_resource_protection_status` | read | Resource and Policy Management API v4 |
| `acronis_fetch_agents` | read | Agent Management REST API 2 |
| `acronis_fetch_agent` | read | Agent Management REST API 2 |
| `acronis_fetch_incidents` | read | Endpoint Detection and Response API 1.0 |
| `acronis_fetch_incident` | read | Endpoint Detection and Response API 1.0 |
| `acronis_fetch_response_action_status` | read | Endpoint Detection and Response API 1.0 |
| `acronis_mark_alert_as_false_positive` | write | Alert Manager 1.0 |
| `acronis_update_investigation_state` | write | Endpoint Detection and Response API 1.0 |
| `acronis_execute_protection_policy` | write | Resource and Policy Management API v4 |
### Excluded categories

Not exposed and not callable, whatever the environment:

- tenant / user / API-client **create and delete**, and all other deletes
- pricing, offering items, usage updates, editions (**money**)
- tokens, one-time tokens (OTT), device authorization, IdP / OpenID configuration
- registration tokens
- branding
- EDR `initiate_response_action`
- everything else not named in `research/tiers.json`

## Response sanitising

Every upstream result passes through `src/sanitize.ts`: text is capped at 100 KB with a truncation
marker; values under keys matching `secret|password|token|access_token|refresh_token|api[_-]?key|authorization|client_secret`
are redacted in JSON; Bearer tokens and JWT-looking strings are redacted anywhere; non-text blocks
are dropped. Errors reach the caller as `{"error":{"code","message"}}` with the message capped at
500 chars and the tenant's credentials scrubbed.

## Credentials

Copy [`.env.example`](.env.example). Leave `CONDUIT_S2S_SECRET` empty in that file.

- **Local / stdio (Claude Desktop, CLI):** set `ACRONIS_BASE_URL`, `ACRONIS_CLIENT_ID`,
  `ACRONIS_CLIENT_SECRET` (an Acronis API client with `client_credentials`). stdio does not use
  `CONDUIT_S2S_SECRET`.
- **Hosted / gateway (`AUTH_MODE=gateway`):** credentials arrive per request and **never** fall back
  to the environment.

| Gateway header | Meaning |
|---|---|
| `X-Acronis-Base-Url` | Datacenter URL, e.g. `https://us5-cloud.acronis.com` |
| `X-Acronis-Client-Id` | API client ID |
| `X-Acronis-Client-Secret` | API client secret |

**Base URL validation (SSRF guard):** https only, hostname must end with `.acronis.com`, no
userinfo, no non-default port, no path/query/fragment. Anything else is rejected (401 in gateway
mode, no child spawned).

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `ACRONIS_BASE_URL` | stdio and `AUTH_MODE=env` | Acronis datacenter URL (see validation above) |
| `ACRONIS_CLIENT_ID` | stdio and `AUTH_MODE=env` | API client ID |
| `ACRONIS_CLIENT_SECRET` | stdio and `AUTH_MODE=env` | API client secret |
| `ACRONIS_ENABLE_WRITES` | No | `true` exposes the 3 write tools. Default `false`. |
| `ACRONIS_POOL_MAX` | No | Max concurrent upstream children (LRU). Default `50`. |
| `ACRONIS_POOL_IDLE_MS` | No | Idle time before a child is closed. Default `600000` (10 min). |
| `MCP_TRANSPORT` | No | `stdio` (default) or `http` |
| `AUTH_MODE` | No | `gateway` (Docker image and Compose default) or `env`. `env` uses `ACRONIS_*` only after S2S auth succeeds. |
| `CONDUIT_S2S_SECRET` | Yes for HTTP | Service-to-service secret. The HTTP server logs an error and exits non-zero when this is empty or a known placeholder. Compose will not start without it. Never commit a real value. Generate one with `openssl rand -hex 32`. |
| `MCP_ALLOW_INSECURE_DEV` | No | Set to `1` only for local development to start HTTP without `CONDUIT_S2S_SECRET`. The process logs a warning, does not enforce `X-Gateway-S2S`, and binds `127.0.0.1` only. A placeholder secret is still refused. |
| `MCP_HTTP_HOST` | No | Bind address when a real `CONDUIT_S2S_SECRET` is set. Defaults to `127.0.0.1`. The container image sets `0.0.0.0`. |
| `MCP_HTTP_PORT` | No | HTTP port. Defaults to `8080`. |
| `LOG_LEVEL` | No | `debug`, `info` (default), `warn`, `error` |

`/health` and `/healthz` stay unauthenticated and do not read credentials.

### X-Gateway-S2S signing

With `MCP_TRANSPORT=http` and `CONDUIT_S2S_SECRET` set, every `/mcp` request must include `X-Gateway-S2S`:

```
X-Gateway-S2S: t=<unix seconds>,v1=<hex hmac-sha256>
```

`v1` is HMAC-SHA256 over the ASCII message `t=<unix seconds>`, keyed with `CONDUIT_S2S_SECRET`, hex-encoded. The timestamp must be within 300 seconds of the server clock. A missing or invalid header returns 401. The secret is never logged.

In `AUTH_MODE=gateway`, `/mcp` also requires the three `X-Acronis-*` headers. A request missing any of them (or carrying an invalid base URL) returns 401 and does not fall back to `ACRONIS_*`.

## Run locally (stdio)

Requires Node >= 22.

```bash
npm install
npm run build
ACRONIS_BASE_URL=https://us5-cloud.acronis.com \
ACRONIS_CLIENT_ID=... ACRONIS_CLIENT_SECRET=... npm start
```

## Run as HTTP (gateway / hosted)

```bash
CONDUIT_S2S_SECRET="$(openssl rand -hex 32)" MCP_TRANSPORT=http AUTH_MODE=env \
ACRONIS_BASE_URL=https://us5-cloud.acronis.com ACRONIS_CLIENT_ID=... ACRONIS_CLIENT_SECRET=... npm start
# → http://127.0.0.1:8080/mcp, health at http://127.0.0.1:8080/health
```

Local HTTP without a secret is development-only. It binds `127.0.0.1` and logs a warning:

```bash
MCP_TRANSPORT=http MCP_ALLOW_INSECURE_DEV=1 npm start
```

## Docker

The image (`node:26-alpine`, runs as user `acronis`) listens on `0.0.0.0` inside the container and
defaults to `AUTH_MODE=gateway`. No registry auth or build secret is needed. The container needs
outbound HTTPS to the Acronis datacenters.

```bash
docker build --platform linux/amd64 -t acronis-mcp .
docker run -e CONDUIT_S2S_SECRET="$(openssl rand -hex 32)" -p 127.0.0.1:8080:8080 acronis-mcp
```

Compose refuses to start when `CONDUIT_S2S_SECRET` is unset and does not inject `ACRONIS_*`:

```bash
CONDUIT_S2S_SECRET="$(openssl rand -hex 32)" docker compose up
```

## Development

```bash
npm install
npm run lint && npm run typecheck && npm test && npm run build
npm run smoke        # dual-era HTTP smoke test (after build)
npm run gen-tools    # regenerate src/generated/tools.ts
```

The integration test spawns the real pinned package. Upstream 1.0.1 needs a token endpoint before it
answers `tools/list`, so the test points `OAUTH_TOKEN_URL` (and a temp `HOME`) at a local fake while
keeping `API_BASE_URL=https://example.acronis.com` and dummy credentials.

## License

Apache-2.0
