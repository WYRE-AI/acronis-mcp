# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

Partially clears the conditions of the security review (WYREAI-711). The items
under "Still open" are NOT done and must stay open until they are.

- The pool is sized from the PEAK memory of the wrapper and the children under
  SUSTAINED load, measured with `scripts/sustained-load.mjs` (the real built
  wrapper, real children, real egress guard, a fake Acronis, the wrapper's event
  loop stalled as at 0.25 vCPU), and a regression test runs it. Measured on
  macOS with Node 26 only, not Linux or the image: before, 691 MiB total
  (wrapper 300, child 200) against a 512 MiB budget; now 330-338 MiB.
- A child runs with `--max-old-space-size=80 --max-semi-space-size=1`, one call
  at a time (more wait in a bounded queue, then `rate_limited`), and the wrapper
  runs with `--max-old-space-size=64 --max-semi-space-size=1`. The egress guard
  aborts any upstream response body over 256 KiB while it streams, before the
  bundle buffers and parses it; the wrapper returns it as a
  `response_too_large` error that names the tool's own narrowing parameters,
  never as a partial list. A child that does not answer `initialize` within 30 s
  is killed.
- The ceiling on children is derived from the container memory
  (`process.constrainedMemory()`, else 512 MiB; `ACRONIS_MEMORY_LIMIT_MB` can
  only lower it)
  from those peaks plus one replacement child and a 15% margin: **1 at 0.5 Gi,
  4 at 1 Gi**. At 0.5 Gi that means few concurrent tenants, cold starts and
  `rate_limited`; raising the container to 1 Gi is recommended (a Conduit
  infrastructure change, not in this repository). `ACRONIS_POOL_MAX` can only
  lower it.
- A new credential beyond the ceiling waits in a bounded queue (8 callers,
  30 s) and is then refused with a `rate_limited` error; it never spawns an
  extra child. A caller that disconnects leaves the queue at once. One tenant
  has at most 9 calls in flight or waiting; the 10th is `rate_limited`.
- An idle child is replaced only after its replacement has started. The child
  being replaced takes no new calls from then on (its tenant queues behind the
  newcomer), and the replacement lasts until the old child has exited, with a
  bounded wait (8 s; the close itself escalates stdin EOF, SIGTERM, SIGKILL), so
  there are never more than max + 1 children alive even when a child is slow to
  close.
- Tenants take turns on a full pool. A child serves its tenant without limit
  while nobody else waits; once another credential waits and the child has held
  its slot for a time slice (10 s, `ACRONIS_POOL_SLICE_MS`), it takes no new
  calls, its in-flight calls finish, and the slot passes to the waiters in
  arrival order. Before, a tenant with a steady stream of calls kept its child
  busy for ever: 2 tenants x 3 callers on one child for 45 s gave 607 calls to
  one and 3 to the other (6 `rate_limited`, longest wait 30.1 s); now 267 and
  223, none refused, longest call 11.3 s (macOS, Node 26).
- An idle child is replaced only once it has been up for a time slice. Before,
  any idle child was replaced the moment another credential waited, so tenants
  that paused between calls swapped the child back and forth, each swap a cold
  start. At 0.5 Gi, 2 tenants x 3 callers, 30 s (macOS, Node 26): spawns per
  minute 38.4 -> 7.9 back to back, 20.3 -> 7.8 with a 500 ms pause, 26.7 -> 7.4
  with a 2 s pause, 28.9 -> 7.4 with 10 tenants; 204 -> 1171 calls back to back.
  The cost: with 10 tenants on one child only about three are served in 30 s and
  the rest get `rate_limited` (before, the swaps spread 59 calls thinly over all
  ten and refused 492). More than about three active tenants needs 1 Gi.
- A child whose spawn fails or times out is killed (SIGKILL) and the spawner
  waits for the process to really exit before it reports the failure. Before, the
  SDK closed the transport itself on a connect timeout, the spawner's own close
  returned at once, and the pool released the replacement slot while the hung
  child was still exiting: 3 live children at max 1 (max + 1 is 2) while a
  newcomer waited, which at 0.5 Gi risks an OOM kill.
- Waiters are woken by one pool timer when an idle child has aged, so they
  re-enter in the order they arrived. Before, each waiter had its own aging
  timer and re-entered in timer order (out of order in 20 of 300 runs of the
  reviewer's 5-waiter script under CPU load; the same script is 0 of 600 now).
- A child that replaces an idle one has an 8 s spawn timeout, not 30 s: the idle
  child takes no new calls until the replacement is up, so a slow newcomer no
  longer holds a healthy tenant for up to 30 s.
- At most 3 callers of one credential wait in the pool queue (of 8), so one
  tenant's parallel callers can no longer fill it and have every other tenant
  refused at once.
- `ACRONIS_POOL_SLICE_MS` is clamped to 1000-15000 ms (1 would respawn per call;
  a huge value brings starvation back). The pool logs one `Upstream pool` line at
  startup with the memory limit it found (or that it is unknown), the derived
  ceiling, the maximum and the slice.
- `CHILD_PEAK_MB` is now 145 (Linux CI, Node 24: child 139-141 MiB, wrapper
  123-128, total 349-350 MiB at 0.5 Gi and 659 MiB at 1 Gi). The ceilings are
  1 at 0.5 Gi, 2 (was 3) at 0.75 Gi, and 4 at 1 Gi.
- `response_too_large` is returned only when the first text block of the error
  is exactly the guard's message (`HTTP request failed: Acronis response is
  larger than N bytes and was not read`). An upstream 400 whose body quotes that
  text is no longer taken for it, which hid the real error.
- `ACRONIS_MEMORY_LIMIT_MB` can only lower the memory the pool sizes for: it is
  capped at `process.constrainedMemory()` and ignored, with a warning, when Node
  cannot read a limit, so a wrong value cannot raise the ceiling past the
  container. (It used to set the limit outright; where Node cannot read the
  container's limit the pool now keeps 1 child.)
- A failed child spawn is remembered for 30 s per credential hash (at most 256
  entries), so a bad or revoked credential cannot cause a spawn per call.
- Host check: the Acronis base URL must be exactly one valid DNS label under
  `acronis.com` (`eu8-cloud.acronis.com`), the same rule as Conduit. Deeper
  names such as `user-content.files.acronis.com` no longer receive the
  `client_secret`.
- Every upstream child preloads `child-egress-guard.cjs`: its `fetch` can reach
  only the origin of its own `API_BASE_URL` and never follows a redirect, so a
  307/308 from the token endpoint can no longer replay the `client_secret` to
  another host. The guard reads the URL once, as a string, and requests that
  string, so an object whose `toString()` names another URL, a `URL` or
  `Request` subclass, or a getter that changes between reads no longer bypasses
  it. Defence in depth, not a sandbox. `redirect: "error"` and the 256 KiB cap
  are untested against a real Acronis tenant.
- Supply chain: `scripts/upstream-pin.json` pins the upstream version, its
  lockfile tarball integrity and the sha256 of every file the package runs
  (`bin/cli.js`, which the pool executes, and `dist/bundle.js`; no file may be
  added or missing, and no symlink is allowed under `bin/` or `dist/`). The
  upstream's own nested `node_modules` is covered only by the lockfile integrity
  and the read-only `/app`. `scripts/verify-upstream.mjs` fails the Docker build,
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
  container memory (1 at 0.5 Gi, 4 at 1 Gi). It was 50 by default. Production
  has been running the default of 50, so check the number of active tenants
  before rolling this out: with more than 1 active tenant at 0.5 Gi there are
  cold starts and `rate_limited` errors. The wrapper now starts with
  `--max-old-space-size=64 --max-semi-space-size=1` (Dockerfile `CMD`).

### Fixed

- `scripts/sustained-load.mjs` now forwards `LOAD_STALL_MS` to the wrapper it
  starts, so `LOAD_STALL_MS=0` really turns the event-loop stall off (the
  wrapper's environment is built from scratch and always ran the default 100).
- A child evicted for idleness is counted against the pool's capacity until its
  process has exited, like a replaced child. Before, it left the pool at once
  while its close was still running, so newcomers started beside it: with max 2,
  an idle timeout of 50 ms and a 300 ms close, two newcomers arriving as two idle
  children were evicted peaked at 4 live children (the reviewer's probe). The
  test at max 2 and max 4 now asserts at most max + 1 live children; at max 4 it
  measured 9 before. The documented bound of max + 1 now holds for every path
  (idle eviction, replacement, crash).
- Shutdown no longer waits for a child that is still starting: `close()` is
  bounded by the 8 s close limit for it too (it used to wait for the child to
  come up, up to the 30 s spawn timeout). Such a child is closed when it does
  come up, or killed by the spawn timeout.
- The spawner removes a child's temporary `HOME` when `chmod` on it fails; it
  used to leave the directory behind.
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
