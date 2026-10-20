/** Tool surface, tier gating, allowlist enforcement, credential binding. */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createMcpServer,
  GATEWAY_HEADERS,
  handleToolCall,
  listToolsResult,
  makeMcpServerFactory,
  type ServerDeps,
} from "../mcp-server.js";
import { UpstreamPool, type Spawner } from "../upstream-pool.js";
import { GENERATED_TOOLS } from "../generated/tools.js";
import { exposedTools, resolveUpstreamName, upstreamAllowlist, writesEnabled } from "../tiers.js";

const tiers = JSON.parse(readFileSync(new URL("../../research/tiers.json", import.meta.url), "utf8")) as {
  read: string[];
  write: string[];
};
const upstream = (
  JSON.parse(readFileSync(new URL("../../research/upstream-tools-1.0.1.json", import.meta.url), "utf8")) as {
    tools: Array<{ name: string }>;
  }
).tools;

const CREDS = { baseUrl: "https://us5-cloud.acronis.com", clientId: "id", clientSecret: "secret-value-123" };

function makeDeps(writes: boolean, result: unknown = { content: [{ type: "text", text: "{}" }] }) {
  const calls: Array<{ name: string; args: unknown }> = [];
  const spawner: Spawner = async () => ({
    callTool: async (name, args) => {
      calls.push({ name, args });
      return result as never;
    },
    listToolNames: async () => [],
    close: async () => undefined,
  });
  const spawnSpy = vi.fn(spawner);
  const pool = new UpstreamPool({ toolsInclude: upstreamAllowlist(writes), spawner: spawnSpy });
  const deps: ServerDeps = { pool, writes };
  return { deps, calls, spawnSpy };
}

describe("tier filtering", () => {
  const resolveExposedName = (upstream: string) => GENERATED_TOOLS.find((g) => g.upstream === upstream)!.tool.name;

  it("renames only through NAME_OVERRIDES: reviewed names are exposed, the child still gets upstream names", () => {
    const byUpstream = new Map(GENERATED_TOOLS.map((g) => [g.upstream, g.tool.name]));
    expect(byUpstream.get("fetch_partner_s_customer_alerts_count")).toBe("acronis_fetch_alert_counts_per_customer");
    expect(byUpstream.get("fetch_tenant_mfastatus")).toBe("acronis_fetch_tenant_mfa_status");
    expect(byUpstream.get("execute_a_protection_policy")).toBe("acronis_execute_protection_policy");
    expect(resolveUpstreamName("acronis_fetch_policies", false)).toBe("fetch_a_list_of_policies");
    expect(resolveUpstreamName("acronis_fetch_a_list_of_policies", false)).toBeUndefined();
  });

  it("exposes exactly the 34 read tools by default, all prefixed acronis_", () => {
    const names = exposedTools(false).map((t) => t.name);
    expect(names).toEqual(tiers.read.map((n) => resolveExposedName(n)));
    expect(names).toHaveLength(34);
    expect(names.every((n) => /^acronis_[a-z0-9_]+$/.test(n))).toBe(true);
  });

  it("adds the 3 write tools only when writes are enabled", () => {
    const names = exposedTools(true).map((t) => t.name);
    expect(names).toHaveLength(37);
    for (const w of tiers.write) {
      expect(names).toContain(resolveExposedName(w));
      expect(exposedTools(false).map((t) => t.name)).not.toContain(resolveExposedName(w));
    }
  });

  it("annotates reads readOnly and writes non-destructive", () => {
    for (const { tier, tool } of GENERATED_TOOLS) {
      if (tier === "read") expect(tool.annotations).toEqual({ readOnlyHint: true });
      else expect(tool.annotations).toEqual({ readOnlyHint: false, destructiveHint: false });
    }
  });

  it("only exposes names that exist exactly once upstream and are in tiers.json", () => {
    const allowed = new Set([...tiers.read, ...tiers.write]);
    for (const g of GENERATED_TOOLS) {
      expect(allowed.has(g.upstream)).toBe(true);
      expect(upstream.filter((u) => u.name === g.upstream)).toHaveLength(1);
    }
    expect(GENERATED_TOOLS).toHaveLength(allowed.size);
  });

  it("never allowlists the known duplicate upstream names", () => {
    const dups = ["device_authorization_approval", "fetch_registration_tokens", "create_registration_token"];
    for (const d of dups) expect(upstreamAllowlist(true)).not.toContain(d);
  });

  it("MCP_TOOLS_INCLUDE list has no wildcards and tracks the tier", () => {
    expect(upstreamAllowlist(false)).toEqual(tiers.read);
    expect(upstreamAllowlist(true)).toEqual([...tiers.read, ...tiers.write]);
    expect(upstreamAllowlist(true).some((n) => n.includes("*"))).toBe(false);
  });

  it("keeps upstream input schemas and shortens descriptions", () => {
    for (const g of GENERATED_TOOLS) {
      const orig = upstream.find((u) => u.name === g.upstream) as unknown as {
        inputSchema: unknown;
        description: string;
      };
      expect(g.tool.inputSchema).toEqual(orig.inputSchema);
      expect(g.tool.description?.length).toBeGreaterThan(0);
      expect(g.tool.description!.length).toBeLessThanOrEqual(300);
      expect(g.tool.description!.startsWith("[")).toBe(false);
      expect(g.tool.description).not.toContain("\n");
    }
  });

  it("writesEnabled is true only for ACRONIS_ENABLE_WRITES=true", () => {
    expect(writesEnabled({})).toBe(false);
    expect(writesEnabled({ ACRONIS_ENABLE_WRITES: "1" })).toBe(false);
    expect(writesEnabled({ ACRONIS_ENABLE_WRITES: "false" })).toBe(false);
    expect(writesEnabled({ ACRONIS_ENABLE_WRITES: "true" })).toBe(true);
  });
});

describe("tools/list without credentials", () => {
  it("returns the same array by reference and spawns nothing", () => {
    const { deps, spawnSpy } = makeDeps(false);
    createMcpServer(deps); // no credentials at all
    expect(listToolsResult(false).tools).toBe(listToolsResult(false).tools);
    expect(listToolsResult(false).tools).toHaveLength(34);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(deps.pool.size).toBe(0);
  });

  it("is identical with and without credentials", () => {
    const { deps } = makeDeps(false);
    createMcpServer(deps);
    const a = listToolsResult(deps.writes).tools.map((t) => t.name);
    createMcpServer(deps, CREDS);
    expect(listToolsResult(deps.writes).tools.map((t) => t.name)).toEqual(a);
  });
});

describe("tools/call enforcement", () => {
  it("rejects non-allowlisted, unprefixed, write-when-disabled and non-string names without spawning", async () => {
    const { deps, spawnSpy } = makeDeps(false);
    for (const name of [
      "acronis_delete_tenant",
      "fetch_all_alerts", // missing prefix
      "acronis_mark_alert_as_false_positive", // write tier, writes disabled
      "acronis_create_registration_token", // duplicate upstream name
      "acronis_*",
      "acronis_get_acronis_skill", // upstream built-in outside MCP_TOOLS_INCLUDE
      "get_acronis_skill",
      "",
      undefined,
      42,
    ]) {
      const res = await handleToolCall(deps, CREDS, name, {});
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0].text).error.code).toBe("tool_not_found");
    }
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("allows write tools when enabled and maps to the upstream name", async () => {
    const { deps, calls } = makeDeps(true);
    const res = await handleToolCall(deps, CREDS, "acronis_update_investigation_state", { a: 1 });
    expect(res.isError).toBeUndefined();
    expect(calls).toEqual([{ name: "update_investigation_state", args: { a: 1 } }]);
    expect(resolveUpstreamName("acronis_execute_protection_policy", true)).toBe("execute_a_protection_policy");
    expect(resolveUpstreamName("acronis_execute_protection_policy", false)).toBeUndefined();
  });

  it("returns missing_credentials for an allowed tool without credentials", async () => {
    const { deps, spawnSpy } = makeDeps(false);
    const res = await handleToolCall(deps, undefined, "acronis_fetch_all_alerts", {});
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error.code).toBe("missing_credentials");
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("uses user-facing copy: Conduit wording in gateway mode, env-var wording only in env mode", async () => {
    const { deps } = makeDeps(false);
    const gw = await handleToolCall({ ...deps, gatewayMode: true }, undefined, "acronis_fetch_all_alerts", {});
    expect(JSON.parse(gw.content[0].text).error.message).toBe(
      "Acronis isn't connected for this organization. An admin can connect it in Conduit under Connections."
    );
    const env = await handleToolCall(deps, undefined, "acronis_fetch_all_alerts", {});
    expect(JSON.parse(env.content[0].text).error.message).toMatch(/ACRONIS_BASE_URL/);
    const off = await handleToolCall(deps, CREDS, "acronis_execute_protection_policy", {});
    expect(JSON.parse(off.content[0].text).error.message).toBe(
      "This Acronis tool isn't available. It may be turned off for this connection."
    );
  });

  it("sanitises upstream results and never echoes credentials in errors", async () => {
    const { deps } = makeDeps(false, {
      content: [{ type: "text", text: JSON.stringify({ id: 1, access_token: "abc.def.ghi", ok: true }) }],
    });
    const res = await handleToolCall(deps, CREDS, "acronis_fetch_all_alerts", {});
    expect(res.content[0].text).toContain('"ok":true');
    expect(res.content[0].text).not.toContain("abc.def.ghi");

    const failing: ServerDeps = {
      writes: false,
      pool: new UpstreamPool({
        toolsInclude: [],
        spawner: async () => {
          throw new Error(`spawn failed for ${CREDS.clientSecret} client_secret=${CREDS.clientSecret}`);
        },
      }),
    };
    const err = await handleToolCall(failing, CREDS, "acronis_fetch_all_alerts", {});
    expect(err.isError).toBe(true);
    expect(err.content[0].text).not.toContain(CREDS.clientSecret);
    expect(JSON.parse(err.content[0].text).error.code).toBe("upstream_unavailable");
  });
});

describe("makeMcpServerFactory credential binding", () => {
  const withEnv = (fn: () => void) => {
    const saved = { ...process.env };
    process.env.ACRONIS_BASE_URL = "https://env.acronis.com";
    process.env.ACRONIS_CLIENT_ID = "env-id";
    process.env.ACRONIS_CLIENT_SECRET = "env-secret-value";
    try {
      fn();
    } finally {
      process.env = saved;
    }
  };

  it("gateway mode uses request headers", async () => {
    const { deps, spawnSpy } = makeDeps(false);
    const headers = new Map<string, string>([
      ["x-acronis-base-url", "https://hdr.acronis.com"],
      ["x-acronis-client-id", "hid"],
      ["x-acronis-client-secret", "hsecret"],
    ]);
    const server = makeMcpServerFactory({ gatewayMode: true }, deps)({
      requestInfo: { headers: { get: (n: string) => headers.get(n) ?? null } },
    } as never);
    expect(server).toBeTruthy();
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("gateway mode with no headers never falls back to env credentials", async () => {
    const { deps, spawnSpy } = makeDeps(false);
    withEnv(() => {
      const factory = makeMcpServerFactory({ gatewayMode: true }, deps);
      expect(() => factory({ requestInfo: { headers: { get: () => null } } } as never)).not.toThrow();
    });
    // Drive a call through a server built with no header creds while env is set.
    const saved = { ...process.env };
    process.env.ACRONIS_BASE_URL = "https://env.acronis.com";
    process.env.ACRONIS_CLIENT_ID = "env-id";
    process.env.ACRONIS_CLIENT_SECRET = "env-secret-value";
    try {
      const { resolveGatewayCredentials } = await import("../credentials.js");
      const r = resolveGatewayCredentials(() => undefined);
      expect(r.credentials).toBeUndefined();
      expect(r.error).toBeTruthy();
      const res = await handleToolCall(deps, r.credentials, "acronis_fetch_all_alerts", {});
      expect(JSON.parse(res.content[0].text).error.code).toBe("missing_credentials");
    } finally {
      process.env = saved;
    }
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("exposes the three gateway header names", () => {
    expect(GATEWAY_HEADERS).toEqual(["X-Acronis-Base-Url", "X-Acronis-Client-Id", "X-Acronis-Client-Secret"]);
  });
});

describe("upstream pinning", () => {
  it("pins @acronis-platform/mcp to the exact version 1.0.1", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies["@acronis-platform/mcp"]).toBe("1.0.1");
    expect(pkg.devDependencies?.["@acronis-platform/mcp"]).toBeUndefined();
  });

  it("has no Axcient leftovers in dependencies", () => {
    const pkg = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    expect(pkg.toLowerCase()).not.toContain("axcient");
  });
});
