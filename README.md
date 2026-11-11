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
- the **sha256 of every file the package can run**: all of `bin/` and `dist/` (`bin/cli.js`, which
  is what the pool executes, and `dist/bundle.js`). A file added or removed there fails the check
  too.

`npm run verify-upstream` (`scripts/verify-upstream.mjs`) checks all of it. It runs in both CI jobs
and in the Dockerfile after `npm prune`, so it checks the `node_modules` that ships; a mismatch
**fails the image build**.

Bumps happen **by pull request only, and a human reviews them**. Dependabot is told to ignore the
package (`.github/dependabot.yml`), so no bump PR exists for it. That is the whole of the repo-side
control: see "Required maintainer actions" below for what a file cannot enforce. A bump needs a
human to

1. diff the new bundle against the old one (beautify both and compare, or at least the outbound
   `fetch`/`http` call sites, the token flow and anything touching `process.env` or the filesystem),
2. diff the upstream `tools/list` against `research/upstream-tools-1.0.1.json` (new, renamed or
   duplicated tools),
3. regenerate `src/generated/tools.ts` with `npm run gen-tools`,
4. re-review `research/tiers.json` and the integration test,
5. update `scripts/upstream-pin.json` (version, `tarballIntegrity` from `npm view <pkg>@<version>
   dist.integrity`, and the sha256 of each file in `files` from `shasum -a 256`).

### Required maintainer actions (repository and organization settings)

`.github/CODEOWNERS` names the owners of the pin, lockfile, Dockerfile, egress guard, pool,
credential and sanitising code, and CI. **None of that is enforced today.** These are settings a
repository admin has to change; nothing in this repo can:

1. **Enable "Require review from Code Owners"** in the branch protection rule on `main`
   (`require_code_owner_reviews` is `false` now).
2. **Require the status checks** `Test on Node.js 22.x`, `Test on Node.js 24.x` and `Code Quality`
   on `main` (none are required now), so the pin check and the image build cannot be skipped.
3. **Exclude `/Dockerfile` and `/.github` from the org's `dependabot-janitor`.** It auto-merges
   green grouped Dependabot PRs, and the `github-actions` and `docker` groups change exactly those
   two paths, which hold the pin check, the guard copy and the image hardening. With 1 and 2 off,
   such a PR can change them with no human review.

Until these are done, a bot can merge a change to the pin check or the Dockerfile unreviewed.

### Egress (what the code does and what it cannot)

The code confines what it can. This is **defence in depth, not a sandbox**:

- The base URL is validated to exactly one label under `acronis.com` (see Credentials).
- Every child preloads `child-egress-guard.cjs`. Its `fetch` may reach only the origin of its own
  `API_BASE_URL` (the URL it checks is the URL it requests, so an object whose `toString()` names
  another URL does not get through), and it passes `redirect: "error"`, so a 307/308 from the token
  endpoint cannot replay the `client_secret` to another host.
- The same wrapper aborts a response body over **512 KiB** while it streams, before the bundle
  buffers and parses it (see "Pool sizing").

**Regression risk, untested against a real tenant:** `redirect: "error"` means any 3xx from Acronis,
for the token endpoint or an API call, now fails the call instead of being followed. Likewise a
response over 512 KiB now fails (the wrapper already cut tool text to 100 KB per block). Both were
tested only against local fakes; neither has been run against a real Acronis tenant, and a datacenter
that redirects legitimately would show up as `upstream_unavailable`.

The guard covers the global `fetch` only. A hostile bundle can still open raw sockets, read files,
and read its siblings' `/proc/<pid>/environ`.

**Restricting the container's outbound traffic to `*.acronis.com` cannot be done from inside the
container or from this repo, and has not been done.** Azure Container Apps gives the container
unrestricted egress by default. It needs an infrastructure change in the Conduit fleet
(`azure/vendor-fleet.bicep` and its environment): a VNet-integrated environment whose outbound
traffic goes through a user-defined route to an FQDN-filtering firewall (for example Azure Firewall)
with an application rule that allows only `*.acronis.com` on 443. Not verified.

**Also not solved (open):** all children run as the same uid as the wrapper. A hostile bundle could
read the other children's `/proc/<pid>/environ` **and the wrapper's own environment, which includes
`CONDUIT_S2S_SECRET`** (the child's environment is built from scratch, but `/proc/<ppid>/environ` is
readable by the same uid). Per-child uids or a hardened `/proc` need container or platform changes.
The pin, the guard, the read-only `/app` (the Dockerfile keeps `/app` root-owned so a child cannot
rewrite the bundle, the guard or the wrapper) and the review above reduce that risk; they do not
remove it. Mirroring or vendoring the tarball (protection against the version being unpublished) is
also not done.

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
- Every child runs with `--max-old-space-size=80` and preloads `child-egress-guard.cjs` (see "Egress" and
  "Pool sizing"). At most 2 calls run in one child at once.
- Idle TTL `ACRONIS_POOL_IDLE_MS` (default 10 min), and every child is closed on shutdown. An
  evicted child that is mid-call is closed when the call ends.

### Pool sizing and failure modes

Memory is the limit, and what counts is a child's **peak**, not its idle size. Measured with the
real child (`resourceUsage().maxRSS`, Node 26 on macOS; **not measured on Linux or in the
container**):

| Child workload (response bodies are JSON) | Peak RSS |
|---|---|
| idle, after `tools/list` | 109 MiB |
| one call returning 450 KiB | 131 MiB |
| two concurrent calls returning 450 KiB each | 145 MiB |
| one call returning 900 KiB | 156 MiB |
| two concurrent calls returning 900 KiB each | 177 MiB |

Before the limits below, the review measured a child at 227 MiB after one 2 MB response, 328 MiB after
5 MB, and over 1.1 GiB (then a crash) after about 25 MB, so one tenant could exhaust the container and
the resulting OOM restart would take every tenant down. A child is now bounded four ways:

- **Heap cap:** it runs with `--max-old-space-size=80`. A child that exhausts its heap dies alone;
  the pool drops it and respawns on the tenant's next call (tested with the real child). This caps the
  V8 heap only, not native or external memory, which the response cap below keeps small.
- **Response cap:** the egress guard aborts any upstream response body over **512 KiB** while it
  streams (or at once, if `Content-Length` says so), before the bundle buffers and parses it. The
  call fails with `Acronis response is larger than 524288 bytes`. 512 KiB is a judgement, not a
  measurement of real Acronis list sizes (see "Egress" for the untested risk); the wrapper already
  cut tool text to 100 KB per block.
- **In-flight cap:** at most **2** calls run in one child. More wait in a per-child queue of at most
  **8** callers for up to **30 s**, then get `rate_limited`.
- **Spawn timeout:** a child that has not answered `initialize` (it fetches its token first) within
  **30 s** is killed.

The ceiling on children is derived from the container's memory limit (`process.constrainedMemory()`,
which reads the cgroup limit; 0, unknown or "unlimited" falls back to 512 MiB):

    children = clamp(floor((limit - 70 wrapper - 110 one child still starting) / 160 peak per child), 1, 4)

| Container memory | Children |
|---|---|
| 0.5 Gi (the fleet today, `azure/vendor-fleet.bicep`) | **2** |
| 0.75 Gi | 3 |
| 1 Gi or more | 4 (hard ceiling) |

At 0.5 Gi that is 2 x about 150 MiB peak + 110 MiB for a child starting + 70 MiB for the wrapper =
about 480 of 512 MiB: it fits, with thin headroom, on numbers that come from macOS. The default size
is this ceiling; `ACRONIS_POOL_MAX` can only lower it (a higher value is clamped and logged). Raise the
container memory, not the variable, to serve more tenants at once.

How the pool behaves at the ceiling:

- A new credential that finds an **idle** child in a full pool spawns its child first and evicts the
  idle one (LRU) only once the new one is up. The pool is then briefly one child over (the "+110"
  above), and at most one such replacement runs at a time. So a stream of bad or varying credentials,
  whose spawns fail, cannot flush healthy tenants' children. A busy child is never evicted.
- If every child is busy, or a replacement is starting, the caller waits in a queue of at most **8**
  callers for up to **30 s**, then is refused at once with `{"error":{"code":"rate_limited",...}}`
  (the 429 case). It never spawns an extra child.
- A caller that disconnects (the MCP request's abort signal, tested over real HTTP) leaves every
  queue at once and frees its place.
- A **failed spawn** (wrong or revoked credentials, no route to the datacenter) is remembered for
  **30 s**, keyed by the credential hash (at most 256 entries), and the same error is returned
  without spawning. After 30 s the next call tries again.

**Rolling this out.** Production runs the old default of 50 today: Conduit's bicep never sets
`ACRONIS_POOL_MAX`. Moving to 2 children at 0.5 Gi (and 0.25 vCPU) means cold starts (a spawn plus a
token fetch, slow at 0.25 vCPU) whenever more than 2 tenants are active, and `rate_limited` when both
children are busy. Check the number of tenants active in a busy hour (distinct credentials calling
this server) before the roll, and raise the container memory first if it is more than 2.

Not bounded: native and external memory of a child beyond what the caps above keep small, and the
wrapper's own memory. The container's OOM restart is still the last backstop for those.

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
| `ACRONIS_POOL_MAX` | No | Max concurrent upstream children. Default and ceiling are derived from the container memory (2 at 0.5 Gi, at most 4); this can only lower it. See "Pool sizing". |
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
npm run verify-upstream  # check the pinned upstream version, lockfile integrity and and the sha256 of every file it runs
```

The integration tests spawn the real pinned package. Upstream 1.0.1 needs a token endpoint before it
answers `tools/list`, so the tests point the child's `API_BASE_URL` (and a temp `HOME`) at a local
fake, with dummy credentials. `http-tenant-isolation.test.ts` goes through the real HTTP server and
checks, against real child processes, that different credentials get separate children and never
see each other's credentials.

## License

Apache-2.0
