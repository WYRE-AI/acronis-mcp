# Contributing

1. Fork and branch off `main`.
2. `npm install`
3. Make your change with tests (`npm test`).
4. `npm run lint && npm run typecheck && npm run build` must pass.
5. `npm run build && npm run smoke` should pass locally if you touched transport/serving code.
6. Commit using [Conventional Commits](https://www.conventionalcommits.org/) — the commit
   type drives the semantic-release version bump (`fix:`, `feat:`, `feat!:`/`BREAKING CHANGE:`).
7. Open a PR against `main`.

## Local testing

```bash
export ACRONIS_BASE_URL=https://us5-cloud.acronis.com ACRONIS_CLIENT_ID=... ACRONIS_CLIENT_SECRET=...
npm run build
npm start   # stdio transport

# HTTP transport (refuses to start until CONDUIT_S2S_SECRET is set):
CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" MCP_TRANSPORT=http npm start

# Local HTTP only, without a service-to-service secret (binds 127.0.0.1):
MCP_ALLOW_INSECURE_DEV=1 MCP_TRANSPORT=http npm start
```

## Bumping the pinned upstream

`@acronis-platform/mcp` is pinned to an exact version, tarball integrity and bundle sha256
(`scripts/upstream-pin.json`). Bump it by PR only, with a human diff of the new bundle (no bot may
merge it; Dependabot ignores the package): update `package.json` and the lockfile, re-capture
`research/upstream-tools-*.json`, run `npm run gen-tools`, review `research/tiers.json`, update
`scripts/upstream-pin.json`, and keep the pinned-version test in sync. `npm run verify-upstream`
must pass. See README "Upstream pinning policy".
