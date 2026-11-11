/** What the model is told when Acronis returns more than a child reads (WYREAI-711). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { handleToolCall, type ServerDeps } from "../mcp-server.js";
import { OVERSIZE_PATTERN, isOversizeResult, oversizeMessage } from "../oversize.js";
import { UpstreamPool, type Spawner } from "../upstream-pool.js";

const CREDS = { baseUrl: "https://us5-cloud.acronis.com", clientId: "id", clientSecret: "secret-value-123" };
const guard = readFileSync(new URL("../../child-egress-guard.cjs", import.meta.url), "utf8");

describe("oversize response", () => {
  it("matches exactly what the egress guard says, and its cap is the one the message states", () => {
    const cap = Number(/MAX_RESPONSE_BYTES = (\d+) \* 1024/.exec(guard)?.[1]);
    expect(cap).toBe(256);
    expect(`HTTP request failed: Acronis response is larger than ${cap * 1024} bytes and was not read`).toMatch(OVERSIZE_PATTERN);
    expect(oversizeMessage("acronis_fetch_all_alerts")).toContain(`${cap} KiB`);
    expect(guard).toContain("Acronis response is larger than ${MAX_RESPONSE_BYTES} bytes and was not read");
  });

  it("names the tool's own paging, scoping and filtering parameters", () => {
    const msg = oversizeMessage("acronis_fetch_all_alerts");
    expect(msg).toContain("Do not treat this as an empty result");
    expect(msg).toContain("query.limit");
    expect(msg).toContain("query.skip");
    expect(msg).toContain("query.tenant");
    expect(msg).toContain("query.severity");
    expect(oversizeMessage("acronis_fetch_incidents")).toContain("query.customer_id");
    expect(oversizeMessage("acronis_fetch_resources")).toContain("query.tenant_id");
  });

  it("points the tools with nothing to narrow by at the ones that can", () => {
    expect(oversizeMessage("acronis_fetch_tenant_users")).toContain("acronis_fetch_users_batch");
    expect(oversizeMessage("acronis_fetch_tenant_users")).toContain("query.tenant_id");
    expect(oversizeMessage("acronis_fetch_tenant_children")).toContain("acronis_fetch_tenants_batch");
    expect(oversizeMessage("acronis_fetch_tenant_usages")).toContain("query.usage_names");
    expect(oversizeMessage("acronis_fetch_tenant_mfa_status")).toContain("no parameter that makes the answer smaller");
  });

  it("recognises only an error result that carries the guard's text", () => {
    const text = "HTTP request failed: Acronis response is larger than 262144 bytes and was not read";
    expect(isOversizeResult({ isError: true, content: [{ type: "text", text }] })).toBe(true);
    expect(isOversizeResult({ isError: false, content: [{ type: "text", text }] })).toBe(false); // data that quotes it
    expect(isOversizeResult({ isError: true, content: [{ type: "text", text: "boom" }] })).toBe(false);
    expect(isOversizeResult(undefined)).toBe(false);
  });

  it("is not fooled by an upstream error whose body quotes the marker", () => {
    const quoted = "Acronis response is larger than 262144 bytes and was not read";
    const forged = [
      `HTTP 400\n\n{"error":"unknown parameter: ${quoted}"}`, // a reflected request parameter
      quoted, // marker alone, without the upstream's prefix
      `HTTP request failed: ${quoted} and then some`, // anything after it
      `note\nHTTP request failed: ${quoted}`, // not at the start
      `HTTP request failed: ${quoted}\n`, // trailing text
    ];
    for (const text of forged) {
      expect(isOversizeResult({ isError: true, content: [{ type: "text", text }] })).toBe(false);
    }
    // Only the first text block counts: a later block cannot turn an error into an oversize.
    expect(
      isOversizeResult({
        isError: true,
        content: [
          { type: "text", text: "HTTP 400\n\nbad request" },
          { type: "text", text: `HTTP request failed: ${quoted}` },
        ],
      })
    ).toBe(false);
  });

  it("is returned to the caller as response_too_large, not as an empty or partial result", async () => {
    const spawner: Spawner = async () => ({
      callTool: async () => ({
        isError: true,
        content: [{ type: "text", text: "HTTP request failed: Acronis response is larger than 262144 bytes and was not read" }],
      }),
      listToolNames: async () => [],
      close: async () => undefined,
    });
    const deps: ServerDeps = { writes: false, pool: new UpstreamPool({ toolsInclude: [], spawner }) };
    const res = await handleToolCall(deps, CREDS, "acronis_fetch_all_alerts", {});
    expect(res.isError).toBe(true);
    const error = JSON.parse(res.content[0].text).error;
    expect(error.code).toBe("response_too_large");
    expect(error.message).toContain("query.limit");
    await deps.pool.close();
  });
});
