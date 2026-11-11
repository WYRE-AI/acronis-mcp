// Preloaded into every upstream child with `node --require` (src/upstream-pool.ts).
//
// The upstream bundle (@acronis-platform/mcp) has no source repo or provenance
// and posts the client_secret to its token endpoint with plain `fetch`, which
// follows redirects. This guard narrows what that fetch can do (WYREAI-711):
//   - only the origin of the child's own API_BASE_URL (the tenant's validated
//     https://<dc>.acronis.com) can be reached,
//   - redirects are refused, so a 307/308 cannot replay the secret elsewhere, and
//   - a response body larger than MAX_RESPONSE_BYTES is aborted while it streams,
//     before the bundle buffers and parses it. Without this, one large response
//     takes a child far past the container's memory (README "Pool sizing").
//
// Defence in depth, not a sandbox. It covers the global `fetch` only: a hostile
// bundle can still open raw sockets, read the filesystem or its siblings'
// /proc/<pid>/environ, so it does not replace an egress firewall or per-child
// isolation (README "Supply chain").
"use strict";

/** Largest upstream response body a child will read (decoded bytes). */
const MAX_RESPONSE_BYTES = 512 * 1024;

const apiOrigin = new URL(process.env.API_BASE_URL).origin;
const realFetch = globalThis.fetch;
// Read through the prototype so a Request subclass cannot report another URL.
const requestUrl = Object.getOwnPropertyDescriptor(Request.prototype, "url").get;

/**
 * The URL being requested, read exactly once. A string or URL is used as is;
 * a Request is passed through (its url comes from the prototype getter); any
 * other object is reduced to the string we checked, so the real fetch cannot
 * coerce it (toString) into a different URL than the one that was approved.
 */
function normalise(input) {
  if (typeof input === "string") return { target: new URL(input), forward: input };
  if (input instanceof URL) return { target: new URL(input.href), forward: input.href };
  if (input instanceof Request) return { target: new URL(requestUrl.call(input)), forward: input };
  const target = new URL(input.url);
  return { target, forward: target.href };
}

function tooLarge() {
  return new Error(`Acronis response is larger than ${MAX_RESPONSE_BYTES} bytes and was not read`);
}

function capBody(response) {
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!response.body) return response;
  let seen = 0;
  const counter = new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > MAX_RESPONSE_BYTES) throw tooLarge();
      controller.enqueue(chunk);
    },
  });
  return new Response(response.body.pipeThrough(counter), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

globalThis.fetch = async (input, init) => {
  const { target, forward } = normalise(input);
  if (target.origin !== apiOrigin) {
    throw new TypeError(`Blocked request to ${target.origin}: only ${apiOrigin} is allowed`);
  }
  return capBody(await realFetch(forward, { ...init, redirect: "error" }));
};
