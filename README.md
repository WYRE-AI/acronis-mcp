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

`@acronis-platform/mcp` has no source repository and no provenance, and it ships as one esbuild
bundle that dependency scanners cannot see into. So it is pinned byte for byte
(`scripts/upstream-pin.json`):

- the **exact** version in `package.json` (no `^`/`~`),
- the tarball **integrity** (sha512) in `package-lock.json`, which `npm ci` enforces, and
- the **sha256 of `dist/bundle.js`**.

`npm run verify-upstream` (`scripts/verify-upstream.mjs`) checks all of it. It runs in both CI jobs
and in the Dockerfile, where a mismatch **fails the image build**.

Bumps happen **by pull request only, and a human reviews them**. Dependabot is told to ignore the
package (`.github/dependabot.yml`), and nothing in this repo auto-merges. `.github/CODEOWNERS` names
the owners of the pin, lockfile, Dockerfile, egress guard and CI. (GitHub enforces CODEOWNERS only if
the branch protection rule on `main` has "Require review from Code Owners" turned on; that is a
repository setting.) A bump needs a human to

1. diff the new bundle against the old one (beautify both and compare, or at least the outbound
   `fetch`/`http` call sites, the token flow and anything touching `process.env` or the filesystem),
2. diff the upstream `tools/list` against `research/upstream-tools-1.0.1.json` (new, renamed or
   duplicated tools),
3. regenerate `src/generated/tools.ts` with `npm run gen-tools`,
4. re-review `research/tiers.json` and the integration test,
5. update `scripts/upstream-pin.json` (version, `tarballIntegrity` from `npm view <pkg>@<version>
   dist.integrity`, and `bundleSha256` from `shasum -a 256`).

### Egress (what the code does and what it cannot)

The code confines what it can:

- The base URL is validated to exactly one label under `acronis.com` (see Credentials).
- Every child preloads `child-egress-guard.cjs`: its `fetch` may reach only the origin of its own
  `API_BASE_URL`, and it never follows a redirect, so a 307/308 from the token endpoint cannot replay
  the `client_secret` to another host. This covers `fetch` only; the bundle could still open raw
  sockets.

**Restricting the container's outbound traffic to `*.acronis.com` cannot be done from inside the
container or from this repo.** Azure Container Apps gives the container unrestricted egress by
default. It needs an infrastructure change in the Conduit fleet (`azure/vendor-fleet.bicep` and its
environment): a VNet-integrated environment whose outbound traffic goes through a user-defined route
to an FQDN-filtering firewall (for example Azure Firewall) with an application rule that allows only
`*.acronis.com` on 443. This has not been done and was not verified.

Also not solved here: all children run as the same uid, so a hostile bundle could read the other
children's `/proc/<pid>/environ`. Per-child uids or a hardened `/proc` need container or platform
changes. The pin, the egress guard and the review above are what reduce that risk today.

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
- Every child also preloads `child-egress-guard.cjs` (see "Egress").
- Idle TTL `ACRONIS_POOL_IDLE_MS` (default 10 min), and every child is closed on shutdown. An
  evicted child that is mid-call is closed when the call ends.

### Pool sizing and failure modes

Memory is the limit. Each child is a full Node process that loads the 5 MB upstream bundle: about
**116 MiB RSS** each (measured with the real child, 5 tenants, Node 26 on macOS; not measured on
Linux or in the container). The fleet gives this container **0.5 Gi**
(`azure/vendor-fleet.bicep`), and the wrapper itself needs about 50-70 MiB, so:

- `ACRONIS_POOL_MAX` defaults to **3** (3 x 116 MiB + the wrapper is about 400 MiB of 512 MiB).
  It is clamped to a hard ceiling of **8**. Raise it only together with the container memory
  (about 130 MiB per child plus 100 MiB for the wrapper) and watch the container's memory metric.
- Idle children are evicted LRU to make room. A busy child is never evicted.
- A new credential that finds the pool full of busy children waits in a queue of at most **8**
  callers for up to **30 s**. Beyond that, or on timeout, the call is refused at once with
  `{"error":{"code":"rate_limited",...}}` (the 429 case). It never spawns a child.
- A **failed spawn** (wrong or revoked credentials, no route to the datacenter) is remembered for
  **30 s**, keyed by the credential hash (at most 256 entries), and the same error is returned
  without spawning. After 30 s the next call tries again.

Not bounded: one child can still grow if upstream returns a very large response. The container's
OOM restart is the backstop.

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
**Before enabling writes (`ACRONIS_ENABLE_WRITES=true`)** two hardening items from the security
review (WYREAI-711) are still open, and the fleet does not enable writes, so only the 34 reads are
served: rejecting `.`, `..`, `/` and `%` in path parameters (which parameters are path parameters
depends on each upstream endpoint, so a blanket string check would break legitimate filters), and a
cap on the total response size (today each text block is capped at 100 KB, not their sum).

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

**Base URL validation (SSRF guard):** https only, hostname must be **exactly one DNS label under
`acronis.com`** (`eu8-cloud.acronis.com`; the same rule as Conduit), no userinfo, no non-default
port, no path/query/fragment. So `acronis.com`, `a.b.acronis.com`, a trailing dot, `evilacronis.com`,
`acronis.com.evil.com` and IDN/punycode look-alikes are all rejected (401 in gateway mode, no child
spawned). The URL parser lowercases the host, so `EU8-Cloud.Acronis.com` is the same host and is
stored lowercase.

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `ACRONIS_BASE_URL` | stdio and `AUTH_MODE=env` | Acronis datacenter URL (see validation above) |
| `ACRONIS_CLIENT_ID` | stdio and `AUTH_MODE=env` | API client ID |
| `ACRONIS_CLIENT_SECRET` | stdio and `AUTH_MODE=env` | API client secret |
| `ACRONIS_ENABLE_WRITES` | No | `true` exposes the 3 write tools. Default `false`. |
| `ACRONIS_POOL_MAX` | No | Max concurrent upstream children. Default `3` (fits 0.5 Gi); clamped to a ceiling of `8`. See "Pool sizing". |
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
outbound HTTPS to the Acronis datacenters (see "Egress" for what restricts it). The build fails if
the installed upstream bundle differs from the pin (`scripts/verify-upstream.mjs`).

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
npm run verify-upstream  # check the pinned upstream version, lockfile integrity and bundle sha256
```

The integration tests spawn the real pinned package. Upstream 1.0.1 needs a token endpoint before it
answers `tools/list`, so the tests point the child's `API_BASE_URL` (and a temp `HOME`) at a local
fake, with dummy credentials. `http-tenant-isolation.test.ts` goes through the real HTTP server and
checks, against real child processes, that different credentials get separate children and never
see each other's credentials.

## License

Apache-2.0
