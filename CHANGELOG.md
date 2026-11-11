# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

Partially clears the conditions of the security review (WYREAI-711). The items
under "Still open" are NOT done and must stay open until they are.

- Each upstream child is bounded by its peak memory, not its idle size. A
  child runs with `--max-old-space-size=80`, so one that exhausts its heap dies
  alone. The egress guard aborts any upstream response body over 512 KiB while
  it streams, before the bundle buffers and parses it. At most 2 calls run in
  one child; more wait in a bounded queue and then get `rate_limited`. A child
  that does not answer `initialize` within 30 s is killed. Measured with the
  real child on macOS: 109 MiB idle, 145 MiB peak with two 450 KiB responses in
  flight, 177 MiB with two 900 KiB. Not measured on Linux or in the container.
- The ceiling on children is derived from the container memory
  (`process.constrainedMemory()`, 512 MiB if unknown): 2 at 0.5 Gi, never above
  4. `ACRONIS_POOL_MAX` can only lower it.
- A new credential beyond the ceiling waits in a bounded queue (8 callers,
  30 s) and is then refused with a `rate_limited` error; it never spawns an
  extra child. A caller that disconnects leaves the queue at once.
- An idle child is replaced only after its replacement has started, so
  failing spawns with varying credentials cannot flush healthy tenants.
- A failed child spawn is remembered for 30 s per credential hash (at most 256
  entries), so a bad or revoked credential cannot cause a spawn per call.
- Host check: the Acronis base URL must be exactly one valid DNS label under
  `acronis.com` (`eu8-cloud.acronis.com`), the same rule as Conduit. Deeper
  names such as `user-content.files.acronis.com` no longer receive the
  `client_secret`.
- Every upstream child preloads `child-egress-guard.cjs`: its `fetch` can reach
  only the origin of its own `API_BASE_URL` and never follows a redirect, so a
  307/308 from the token endpoint can no longer replay the `client_secret` to
  another host. The guard requests the URL it checked, so an object whose
  `toString()` names another URL no longer bypasses it. Defence in depth, not a
  sandbox. `redirect: "error"` and the 512 KiB cap are untested against a real
  Acronis tenant.
- Supply chain: `scripts/upstream-pin.json` pins the upstream version, its
  lockfile tarball integrity and the sha256 of every file the package runs
  (`bin/cli.js`, which the pool executes, and `dist/bundle.js`; no file may be
  added or missing). `scripts/verify-upstream.mjs` fails the Docker build,
  after `npm prune`, and CI on any difference. Dependabot ignores
  `@acronis-platform/mcp`.
- The image keeps `/app` root-owned and read-only for the app user, so a child
  cannot rewrite the pinned bundle, the guard or the wrapper. CI checks it.
- `CODEOWNERS` names owners for the pin, lockfile, Dockerfile, guard, pool,
  credential, sanitising and S2S code, and CI.

#### Still open (not done by this change)

- Restricting the container's outbound traffic to `*.acronis.com`. It needs a
  Conduit fleet infrastructure change (VNet-integrated environment with an
  FQDN-filtering firewall); nothing in this repo can do it.
- All children run as the same uid as the wrapper: a hostile bundle can read
  the other children's `/proc/<pid>/environ` and the wrapper's environment
  (including `CONDUIT_S2S_SECRET`).
- Mirroring or vendoring the upstream tarball.
- Repository and organization settings, which a file cannot enforce: "Require
  review from Code Owners" on `main` (off), required status checks (none), and
  excluding `/Dockerfile` and `/.github` from the org's `dependabot-janitor`,
  which can auto-merge grouped github-actions and docker PRs touching them. Until
  then CODEOWNERS and the CI pin check are advisory.
- Before enabling writes: rejecting `.`, `..`, `/` and `%` in path parameters.

### Changed

- The default and maximum number of upstream children now come from the
  container memory (2 at 0.5 Gi, at most 4). It was 50 by default. Production
  has been running the default of 50, so check the number of active tenants
  before rolling this out: with more than 2 active tenants at 0.5 Gi there are
  cold starts and `rate_limited` errors.

### Fixed

- Redaction of upstream tool output is now linear-time. The key/value and JWT
  regexes were quadratic or cubic on hostile text (a 16 KB tool result of
  repeated `-token` took about 57 s; a 4 MB one now takes about 30 ms).
  Key/value output is unchanged.
- JWT-shaped tokens glued to a word (`id_eyJ…`) or to the end of another JWT
  are now fully redacted, including the second token's payload and signature.
- A JWT whose header follows a JWT-shaped segment (`eyJaaaaa.<jwt>`,
  `xeyJaaaaa.<jwt>`) no longer keeps its signature. The extra JWT redaction
  now runs after the key/value passes, so it can no longer remove a key name
  (`…eyJ….payload.password: x`) and let that key's value through. Redaction
  never covers less than the former regexes did.
- Redaction no longer throws `RangeError: Maximum call stack size exceeded`
  when a JSON string value, a `Bearer`/`Basic` token or another single match
  is a few million characters long. Values and tokens are now found by forward
  scans instead of regex repeats.

### Added

- HTTP-level tenant isolation test with real child processes: different
  credentials get separate children, the same credentials reuse one, and one
  request's credentials never reach another request's child, traffic or
  response (WYREAI-711).
- Tests of the memory limits with the real upstream child: a hostile endless
  response is aborted and leaves the child and other tenants working; a child
  that exhausts its heap dies alone and is respawned; a silent child is killed
  after the spawn timeout. Tests of the egress guard (URL normalisation,
  redirects, response cap) and of a caller disconnect freeing its queue place
  over real HTTP (WYREAI-711).
- Regression test: a malformed request target such as `//h:99999/` answers
  400 without an unhandled rejection.
