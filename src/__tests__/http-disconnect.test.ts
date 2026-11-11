/**
 * A caller that disconnects mid-request must free its place in the pool's queues
 * (WYREAI-711). The pool does that through the AbortSignal it is given, so this
 * checks the whole path over real HTTP: client aborts the request -> the MCP
 * SDK aborts ctx.mcpReq.signal -> handleToolCall passes it to the pool.
 */
import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startHttpTransport } from "../index.js";
import { UpstreamPool, setDefaultSpawner, type UpstreamConnection } from "../upstream-pool.js";

const S2S_SECRET = "disconnect-test-s2s-secret";
let sidecar: Server | undefined;

beforeAll(() => {
  process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
  process.env.AUTH_MODE = "gateway";
  process.env.MCP_HTTP_PORT = "0";
  process.env.MCP_HTTP_HOST = "127.0.0.1";
  process.env.LOG_LEVEL = "error";
});

afterAll(() => {
  setDefaultSpawner(undefined);
  delete process.env.CONDUIT_S2S_SECRET;
  delete process.env.AUTH_MODE;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((r) => (sidecar ? sidecar.close(() => r()) : r()));
  sidecar = undefined;
});

describe("caller disconnect", () => {
  it("aborts the signal the pool is given when the HTTP client goes away", async () => {
    let seen: AbortSignal | undefined;
    const original = UpstreamPool.prototype.withConnection;
    vi.spyOn(UpstreamPool.prototype, "withConnection").mockImplementation(function (this: UpstreamPool, creds, fn, signal) {
      seen = signal;
      return original.call(this, creds, fn, signal);
    });
    let started!: () => void;
    const callStarted = new Promise<void>((r) => (started = r));
    setDefaultSpawner(async () => {
      const conn: UpstreamConnection = {
        callTool: () => {
          started();
          return new Promise(() => undefined); // never answers
        },
        listToolNames: async () => [],
        close: async () => undefined,
      };
      return conn;
    });

    sidecar = await startHttpTransport();
    const url = `http://127.0.0.1:${(sidecar.address() as AddressInfo).port}/mcp`;
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", S2S_SECRET).update(`t=${t}`).digest("hex");
    const client = new AbortController();
    const request = fetch(url, {
      method: "POST",
      signal: client.signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-gateway-s2s": `t=${t},v1=${sig}`,
        "x-acronis-base-url": "https://eu8-cloud.acronis.com",
        "x-acronis-client-id": "client",
        "x-acronis-client-secret": "secret",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "acronis_fetch_all_alerts", arguments: {} } }),
    }).catch(() => undefined);

    await callStarted;
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(false);
    client.abort();
    await request;
    await vi.waitFor(() => expect(seen?.aborted).toBe(true), { timeout: 5_000 });
  }, 30_000);
});
