/**
 * Spawns the REAL pinned @acronis-platform/mcp child through the production
 * spawn path and checks MCP_TOOLS_INCLUDE restricts it to the allowlist.
 *
 * NOTE: upstream 1.0.1 fetches a client_credentials token eagerly at startup
 * (before it will answer tools/list), so "dummy creds, no API contact" is not
 * possible. The child still gets API_BASE_URL=https://example.acronis.com and
 * dummy credentials; only OAUTH_TOKEN_URL (and a temp HOME for the upstream's
 * token cache) are redirected to a local fake token endpoint.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upstreamAllowlist } from "../tiers.js";
import { UpstreamPool, createStdioSpawner } from "../upstream-pool.js";

const CREDS = {
  baseUrl: "https://example.acronis.com",
  clientId: "dummy-client-id",
  clientSecret: "dummy-client-secret",
};

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const FAKE_JWT = `${b64({ alg: "none" })}.${b64({ scope: [{ tid: "00000000-0000-0000-0000-000000000000" }] })}.sig`;

/**
 * Upstream 1.0.1 registers this built-in tool regardless of MCP_TOOLS_INCLUDE
 * (it is not in tools/list's 159). The wrapper never exposes or forwards it:
 * that is why the allowlist is enforced a second time in our call handler.
 */
const UPSTREAM_BUILTIN_EXTRAS = ["get_acronis_skill"];
const withoutExtras = (names: string[]) => names.filter((n) => !UPSTREAM_BUILTIN_EXTRAS.includes(n));

let fake: Server;
let spawner: ReturnType<typeof createStdioSpawner>;
let home: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "acronis-mcp-it-"));
  fake = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/idp/token")) {
      res.end(JSON.stringify({ access_token: FAKE_JWT, expires_in: 3600, token_type: "bearer" }));
    } else {
      res.end(JSON.stringify({ items: [] }));
    }
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  const { port } = fake.address() as AddressInfo;
  spawner = createStdioSpawner({
    OAUTH_TOKEN_URL: `http://127.0.0.1:${port}/api/2/idp/token`,
    HOME: home,
  });
});

afterAll(async () => {
  await new Promise<void>((r) => fake.close(() => r()));
  rmSync(home, { recursive: true, force: true });
});

describe("real upstream child", () => {
  it("lists exactly the read-tier allowlist", async () => {
    const allow = upstreamAllowlist(false);
    const pool = new UpstreamPool({ toolsInclude: allow, spawner });
    try {
      const names = await pool.withConnection(CREDS, (c) => c.listToolNames());
      expect(withoutExtras(names).sort()).toEqual([...allow].sort());
      expect(names).not.toContain("mark_alert_as_false_positive");
      expect(names).not.toContain("create_registration_token");
    } finally {
      await pool.close();
    }
  }, 60_000);

  it("lists the write tools only when they are in MCP_TOOLS_INCLUDE", async () => {
    const allow = upstreamAllowlist(true);
    const pool = new UpstreamPool({ toolsInclude: allow, spawner });
    try {
      const names = await pool.withConnection(CREDS, (c) => c.listToolNames());
      expect(withoutExtras(names).sort()).toEqual([...allow].sort());
      expect(names).toContain("execute_a_protection_policy");
    } finally {
      await pool.close();
    }
  }, 60_000);

  it("reports a clean failure when the token endpoint rejects the credentials", async () => {
    const bad = createServer((_req, res) => {
      res.statusCode = 401;
      res.end('{"error":"invalid_client"}');
    });
    await new Promise<void>((r) => bad.listen(0, "127.0.0.1", r));
    const { port } = bad.address() as AddressInfo;
    const pool = new UpstreamPool({
      toolsInclude: upstreamAllowlist(false),
      spawner: createStdioSpawner({ OAUTH_TOKEN_URL: `http://127.0.0.1:${port}/api/2/idp/token`, HOME: home }),
    });
    try {
      await expect(pool.withConnection(CREDS, (c) => c.listToolNames())).rejects.toThrow();
      expect(pool.size).toBe(0);
    } finally {
      await pool.close();
      await new Promise<void>((r) => bad.close(() => r()));
    }
  }, 60_000);
});
