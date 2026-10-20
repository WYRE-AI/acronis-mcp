/**
 * Tool surface and tier gating. Only tools present in the generated
 * allowlist (research/tiers.json) are ever exposed or callable.
 */
import type { Tool } from "@modelcontextprotocol/server";
import { GENERATED_TOOLS } from "./generated/tools.js";

export const TOOL_PREFIX = "acronis_";

export function writesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.ACRONIS_ENABLE_WRITES ?? "").trim().toLowerCase() === "true";
}

const READ_TOOLS = GENERATED_TOOLS.filter((t) => t.tier === "read");
const ALL_TOOLS = GENERATED_TOOLS;

// Deterministic, built once. Identical for every caller and every request.
const READ_LIST: Tool[] = READ_TOOLS.map((t) => t.tool);
const ALL_LIST: Tool[] = ALL_TOOLS.map((t) => t.tool);

/** Tool definitions for tools/list. Same array reference every call. */
export function exposedTools(writes: boolean): Tool[] {
  return writes ? ALL_LIST : READ_LIST;
}

/** Upstream names to hand to the child as MCP_TOOLS_INCLUDE (never contains a wildcard). */
export function upstreamAllowlist(writes: boolean): string[] {
  return (writes ? ALL_TOOLS : READ_TOOLS).map((t) => t.upstream);
}

/**
 * Map a caller-facing tool name to the upstream name, or undefined when the
 * tool is not allowlisted for the enabled tiers (second enforcement layer).
 */
export function resolveUpstreamName(name: unknown, writes: boolean): string | undefined {
  if (typeof name !== "string") return undefined;
  const entry = (writes ? ALL_TOOLS : READ_TOOLS).find((t) => t.tool.name === name);
  return entry?.upstream;
}
