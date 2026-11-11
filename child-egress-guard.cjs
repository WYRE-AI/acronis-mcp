// Preloaded into every upstream child with `node --require` (src/upstream-pool.ts).
//
// The upstream bundle (@acronis-platform/mcp) has no source repo or provenance
// and posts the client_secret to its token endpoint with plain `fetch`, which
// follows redirects. This guard narrows what that fetch can do (WYREAI-711):
//   - only the origin of the child's own API_BASE_URL (the tenant's validated
//     https://<dc>.acronis.com) can be reached, and
//   - redirects are refused, so a 307/308 cannot replay the secret elsewhere.
// It covers `fetch` only. A hostile bundle could still open raw sockets, so it
// does not replace an egress firewall (see README "Supply chain").
"use strict";

const apiOrigin = new URL(process.env.API_BASE_URL).origin;
const realFetch = globalThis.fetch;

globalThis.fetch = (input, init) => {
  const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (target.origin !== apiOrigin) {
    return Promise.reject(new TypeError(`Blocked request to ${target.origin}: only ${apiOrigin} is allowed`));
  }
  return realFetch(input, { ...init, redirect: "error" });
};
