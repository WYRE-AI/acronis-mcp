# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

Conditions of the security review (WYREAI-711), to clear before the vendor is un-hidden.

- Upstream pool is bounded to the container's memory. Each upstream child is a
  full Node process (about 116 MiB RSS), so the old default of 50 could not fit
  the 0.5 Gi container. `ACRONIS_POOL_MAX` now defaults to 3 and is clamped to a
  hard ceiling of 8. A new credential beyond the cap waits in a bounded queue
  (8 callers, 30 s) and is then refused with a `rate_limited` error; it never
  spawns a child.
- A failed child spawn is remembered for 30 s per credential hash (at most 256
  entries), so a bad or revoked credential cannot cause a spawn per call.
- Host check: the Acronis base URL must be exactly one valid DNS label under
  `acronis.com` (`eu8-cloud.acronis.com`), the same rule as Conduit. Deeper
  names such as `user-content.files.acronis.com` no longer receive the
  `client_secret`.
- Every upstream child preloads `child-egress-guard.cjs`: its `fetch` can reach
  only the origin of its own `API_BASE_URL` and never follows a redirect, so a
  307/308 from the token endpoint can no longer replay the `client_secret` to
  another host.
- Supply chain: `scripts/upstream-pin.json` pins the upstream version, its
  lockfile tarball integrity and the sha256 of `dist/bundle.js`.
  `scripts/verify-upstream.mjs` fails the Docker build and CI on any
  difference. Dependabot ignores `@acronis-platform/mcp`, and `CODEOWNERS`
  requires a human owner for the pin, lockfile, Dockerfile and CI.

### Changed

- `ACRONIS_POOL_MAX` default is 3 (was 50), and values above 8 are clamped.
  Raise it only together with the container memory.

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
- Regression test: a malformed request target such as `//h:99999/` answers
  400 without an unhandled rejection.
