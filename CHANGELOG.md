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

### Added

- Regression test: a malformed request target such as `//h:99999/` answers
  400 without an unhandled rejection.
