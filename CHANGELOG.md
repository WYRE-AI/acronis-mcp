# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

- Regression test: a malformed request target such as `//h:99999/` answers
  400 without an unhandled rejection.
