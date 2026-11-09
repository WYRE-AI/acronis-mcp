/**
 * HTTP transport fail-closed auth (CWE-306).
 *
 * Startup requires a real CONDUIT_S2S_SECRET. Known placeholders are rejected.
 * MCP_ALLOW_INSECURE_DEV=1 starts only when the secret is empty, and binds
 * 127.0.0.1 only. /mcp rejects a missing or invalid X-Gateway-S2S header.
 * AUTH_MODE=gateway rejects requests that omit the X-Acronis-* credential headers
 * and must not fall back to the ACRONIS_* environment variables.
 */
import { createHmac } from "node:crypto";
import { request as httpRequest, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const spawnCalls = vi.hoisted(() => [] as Array<{ clientId: string; clientSecret: string; baseUrl: string }>);

import { setDefaultSpawner } from "../upstream-pool.js";
import { startHttpTransport } from "../index.js";

const S2S_SECRET = "s2s-do-not-log-7f3a9c";
const ENV_SECRET = "env-client-secret-must-not-leak";
const HEADER_SECRET = "header-client-secret-do-not-log";
const ENV_BASE = "https://env-dc.acronis.com";
const HEADER_BASE = "https://hdr-dc.acronis.com";
const credHeaders = (secret = HEADER_SECRET): Record<string, string> => ({
  "x-acronis-base-url": HEADER_BASE,
  "x-acronis-client-id": "header-client-id",
  "x-acronis-client-secret": secret,
});

const ENV_KEYS = [
  "CONDUIT_S2S_SECRET",
  "MCP_ALLOW_INSECURE_DEV",
  "MCP_HTTP_PORT",
  "MCP_HTTP_HOST",
  "AUTH_MODE",
  "ACRONIS_BASE_URL",
  "ACRONIS_CLIENT_ID",
  "ACRONIS_CLIENT_SECRET",
  "LOG_LEVEL",
  "MCP_TRANSPORT",
] as const;

const savedEnv = new Map<string, string | undefined>();
const openServers: HttpServer[] = [];

function mintS2sHeader(secret: string, unixSeconds = Math.floor(Date.now() / 1000)): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac("sha256", secret).update(message).digest("hex");
  return `${message},v1=${hex}`;
}

function captureStderr(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  return {
    text: () => lines.join(""),
    restore: () => spy.mockRestore(),
  };
}

function exitSpy() {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${String(code)}`);
  }) as typeof process.exit);
}

interface HttpResult {
  status: number;
  body: string;
  contentType: string;
}

function sendHttp(options: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port: options.port,
        method: options.method,
        path: options.path,
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            contentType: String(res.headers["content-type"] ?? ""),
          });
        });
      }
    );
    req.setTimeout(5000, () => {
      req.destroy(new Error(`timeout ${options.method} ${options.path}`));
    });
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function parseMcpBody(result: HttpResult): unknown {
  if (result.contentType.includes("text/event-stream")) {
    const dataLines = result.body.split("\n").filter((line) => line.startsWith("data:"));
    const last = dataLines[dataLines.length - 1];
    if (!last) throw new Error(`No data frame in SSE body: ${result.body}`);
    return JSON.parse(last.slice("data:".length).trim());
  }
  return JSON.parse(result.body);
}

async function listen(): Promise<{ port: number; address: string; close: () => Promise<void> }> {
  const server = await startHttpTransport();
  openServers.push(server);
  const bound = server.address() as AddressInfo | string | null;
  if (!bound || typeof bound === "string") {
    throw new Error("HTTP server did not bind a TCP port");
  }
  return {
    port: bound.port,
    address: bound.address,
    close: () =>
      new Promise((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function mcpHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...extra,
  };
}

const toolsList = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/list",
  params: {},
});

const alertsCall = JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: "acronis_fetch_all_alerts", arguments: {} },
});

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  process.env.MCP_HTTP_PORT = "0";
  process.env.MCP_HTTP_HOST = "127.0.0.1";
  process.env.LOG_LEVEL = "error";
  delete process.env.CONDUIT_S2S_SECRET;
  delete process.env.MCP_ALLOW_INSECURE_DEV;
  delete process.env.AUTH_MODE;
  delete process.env.ACRONIS_BASE_URL;
  delete process.env.ACRONIS_CLIENT_ID;
  delete process.env.ACRONIS_CLIENT_SECRET;
  delete process.env.ACRONIS_ENABLE_WRITES;
  delete process.env.MCP_TRANSPORT;
  spawnCalls.length = 0;
  setDefaultSpawner(async (creds) => {
    spawnCalls.push(creds);
    return {
      callTool: async () => ({
        content: [{ type: "text", text: JSON.stringify({ items: [{ id: "alert-1", title: "Header Org alert" }] }) }],
      }),
      listToolNames: async () => [],
      close: async () => undefined,
    };
  });
});

afterEach(async () => {
  setDefaultSpawner(undefined);
  while (openServers.length > 0) {
    const server = openServers.pop();
    if (!server?.listening) continue;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

describe("HTTP startup", () => {
  it("refuses to start when CONDUIT_S2S_SECRET is empty", async () => {
    const logs = captureStderr();
    const exit = exitSpy();
    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      expect(exit).toHaveBeenCalledWith(1);
      const text = logs.text();
      expect(text).toContain("Refusing to start HTTP transport");
      expect(text).toContain("CONDUIT_S2S_SECRET is empty");
      expect(text).not.toContain(S2S_SECRET);
    } finally {
      exit.mockRestore();
      logs.restore();
    }
  });

  it("still refuses when MCP_ALLOW_INSECURE_DEV is not exactly 1", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "true";
    const logs = captureStderr();
    const exit = exitSpy();
    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      expect(logs.text()).toContain("Refusing to start HTTP transport");
      expect(logs.text()).toContain("CONDUIT_S2S_SECRET is empty");
    } finally {
      exit.mockRestore();
      logs.restore();
    }
  });

  it.each([
    "changeme",
    "ChangeMe",
    "  changeme  ",
    "replace-with-a-real-secret",
    "your-s2s-secret",
    "s2s-secret",
    "example",
  ])("refuses known placeholder %j even when the insecure flag is set", async (placeholder) => {
    process.env.CONDUIT_S2S_SECRET = placeholder;
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    const logs = captureStderr();
    const exit = exitSpy();
    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      expect(exit).toHaveBeenCalledWith(1);
      const text = logs.text();
      expect(text).toContain("known placeholder");
      expect(text).toContain("openssl rand -hex 32");
      expect(text).not.toContain(placeholder.trim());
      expect(text).not.toContain(S2S_SECRET);
    } finally {
      exit.mockRestore();
      logs.restore();
    }
  });

  it.each(["secret", "placeholder", "SECRET"])(
    "refuses the short placeholder %j",
    async (placeholder) => {
      process.env.CONDUIT_S2S_SECRET = placeholder;
      const logs = captureStderr();
      const exit = exitSpy();
      try {
        await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
        expect(logs.text()).toContain("known placeholder");
      } finally {
        exit.mockRestore();
        logs.restore();
      }
    }
  );

  it("allows startup with a warning when MCP_ALLOW_INSECURE_DEV=1 and binds 127.0.0.1", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    delete process.env.MCP_HTTP_HOST;
    const logs = captureStderr();
    try {
      const server = await listen();
      expect(server.address).toBe("127.0.0.1");
      const text = logs.text();
      expect(text).toContain("SECURITY WARNING");
      expect(text).toContain("CONDUIT_S2S_SECRET");
      expect(text).toContain("MCP_ALLOW_INSECURE_DEV=1");
      expect(text).toContain("127.0.0.1");
      expect(text).not.toContain(S2S_SECRET);
    } finally {
      logs.restore();
    }
  });

  it.each(["0.0.0.0", "10.1.2.3", "localhost"])(
    "forces 127.0.0.1 when the dev bypass is set and MCP_HTTP_HOST is %s",
    async (host) => {
      process.env.MCP_ALLOW_INSECURE_DEV = "1";
      process.env.MCP_HTTP_HOST = host;
      const logs = captureStderr();
      try {
        const server = await listen();
        expect(server.address).toBe("127.0.0.1");
        const text = logs.text();
        expect(text).toContain("SECURITY WARNING");
        expect(text).toContain(`MCP_HTTP_HOST=${host}`);
        expect(text).toContain("binds 127.0.0.1 only");
        expect(text).not.toContain(S2S_SECRET);
      } finally {
        logs.restore();
      }
    }
  );

  it("honors a non-loopback MCP_HTTP_HOST when CONDUIT_S2S_SECRET is set", async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.MCP_HTTP_HOST = "0.0.0.0";
    const logs = captureStderr();
    try {
      const server = await listen();
      expect(server.address).toBe("0.0.0.0");
      expect(logs.text()).not.toContain("binds 127.0.0.1 only");
      expect(logs.text()).not.toContain(S2S_SECRET);
    } finally {
      logs.restore();
    }
  });

  it("binds 127.0.0.1 when MCP_HTTP_HOST is unset and a secret is set", async () => {
    delete process.env.MCP_HTTP_HOST;
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    const server = await listen();
    expect(server.address).toBe("127.0.0.1");
  });
});

describe("HTTP /mcp authentication", () => {
  beforeEach(() => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = "gateway";
    process.env.ACRONIS_BASE_URL = ENV_BASE;
    process.env.ACRONIS_CLIENT_ID = "env-client-id";
    process.env.ACRONIS_CLIENT_SECRET = ENV_SECRET;
  });

  it("returns 401 when the S2S header is missing or invalid and does not log the secret", async () => {
    const logs = captureStderr();
    const server = await listen();
    try {
      const missing = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders({ ...credHeaders() }),
        body: toolsList,
      });
      const invalid = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders({
          "x-gateway-s2s": mintS2sHeader("wrong-secret"),
          ...credHeaders(),
        }),
        body: toolsList,
      });

      expect(missing.status).toBe(401);
      expect(invalid.status).toBe(401);
      expect(missing.body).toContain("X-Gateway-S2S");
      expect(invalid.body).toContain("X-Gateway-S2S");
      expect(missing.body).not.toContain(S2S_SECRET);
      expect(invalid.body).not.toContain(S2S_SECRET);
      expect(missing.body).not.toContain(ENV_SECRET);
      expect(invalid.body).not.toContain(HEADER_SECRET);
      expect(logs.text()).not.toContain(S2S_SECRET);
      expect(logs.text()).not.toContain(ENV_SECRET);
      expect(spawnCalls).toEqual([]);
    } finally {
      logs.restore();
    }
  });

  it("returns 401 in gateway mode without credential headers and does not use env credentials", async () => {
    const server = await listen();
    const response = await sendHttp({
      port: server.port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders({ "x-gateway-s2s": mintS2sHeader(S2S_SECRET) }),
      body: alertsCall,
    });

    expect(response.status).toBe(401);
    expect(response.body).toContain("X-Acronis-Client-Secret");
    expect(response.body).not.toContain(ENV_SECRET);
    expect(response.body).not.toContain(S2S_SECRET);
    expect(spawnCalls).toEqual([]);

    const empty = await sendHttp({
      port: server.port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders({
        "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
        ...credHeaders(""),
      }),
      body: alertsCall,
    });
    expect(empty.status).toBe(401);
    expect(spawnCalls).toEqual([]);
  });

  it.each([
    "http://hdr-dc.acronis.com",
    "https://evil.example.com",
    "https://acronis.com.evil.com",
    "https://169.254.169.254",
  ])("returns 401 for an invalid gateway base URL %s and spawns nothing", async (badBase) => {
    const server = await listen();
    const response = await sendHttp({
      port: server.port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders({
        "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
        ...credHeaders(),
        "x-acronis-base-url": badBase,
      }),
      body: alertsCall,
    });
    expect(response.status).toBe(401);
    expect(response.body).not.toContain(HEADER_SECRET);
    expect(spawnCalls).toEqual([]);
  });

  it("accepts a valid S2S header plus the credential header and uses that credential", async () => {
    const logs = captureStderr();
    const server = await listen();
    try {
      const listed = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders({
          "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
          ...credHeaders(),
        }),
        body: toolsList,
      });
      expect(listed.status).toBe(200);
      const listPayload = parseMcpBody(listed) as { result?: { tools?: Array<{ name?: string }> } };
      expect(listPayload.result?.tools?.some((tool) => tool.name === "acronis_fetch_all_alerts")).toBe(true);
      expect(listed.body).not.toContain(S2S_SECRET);
      expect(listed.body).not.toContain(ENV_SECRET);
      expect(listed.body).not.toContain(HEADER_SECRET);
      expect(spawnCalls).toEqual([]);

      const called = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders({
          "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
          ...credHeaders(),
        }),
        body: alertsCall,
      });
      expect(called.status).toBe(200);
      const callPayload = parseMcpBody(called) as {
        result?: { content?: Array<{ text?: string }> };
      };
      const text = callPayload.result?.content?.[0]?.text ?? "";
      expect(text).toContain("Header Org alert");
      expect(called.body).not.toContain(ENV_SECRET);
      expect(called.body).not.toContain(S2S_SECRET);
      expect(called.body).not.toContain(HEADER_SECRET);
      expect(spawnCalls).toEqual([
        { baseUrl: HEADER_BASE, clientId: "header-client-id", clientSecret: HEADER_SECRET },
      ]);
      expect(logs.text()).not.toContain(S2S_SECRET);
      expect(logs.text()).not.toContain(ENV_SECRET);
      expect(logs.text()).not.toContain(HEADER_SECRET);
    } finally {
      logs.restore();
    }
  });

  it.each(["//h:99999/", "//[::1/mcp", "//user@:0x/health"])(
    "answers 400 for the malformed request target %s without an unhandled rejection",
    async (path) => {
      expect(() => new URL(path, "http://localhost")).toThrow();
      const rejections: unknown[] = [];
      const onRejection = (reason: unknown) => rejections.push(reason);
      process.on("unhandledRejection", onRejection);
      try {
        const server = await listen();
        const response = await sendHttp({ port: server.port, method: "GET", path });
        expect(response.status).toBe(400);
        expect(JSON.parse(response.body)).toEqual({ error: "Bad request" });
        // The server keeps serving afterwards.
        const health = await sendHttp({ port: server.port, method: "GET", path: "/health" });
        expect(health.status).toBe(200);
        await new Promise((resolve) => setImmediate(resolve));
        expect(rejections).toEqual([]);
        expect(spawnCalls).toEqual([]);
      } finally {
        process.off("unhandledRejection", onRejection);
      }
    }
  );

  it("serves /health and /healthz without authentication and without reading credentials", async () => {
    const server = await listen();
    for (const path of ["/health", "/healthz"]) {
      const response = await sendHttp({ port: server.port, method: "GET", path });
      expect(response.status).toBe(200);
      const body = JSON.parse(response.body) as { status?: string; authMode?: string };
      expect(body.status).toBe("ok");
      expect(body.authMode).toBe("gateway");
      expect(response.body).not.toContain(S2S_SECRET);
      expect(response.body).not.toContain(ENV_SECRET);
    }
    expect(spawnCalls).toEqual([]);
  });
});
