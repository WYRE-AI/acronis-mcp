/**
 * What to tell the model when Acronis returned more than a child will read
 * (the 256 KiB cap in child-egress-guard.cjs, WYREAI-711).
 *
 * The result is an error, not a truncated list. The cap is applied to the raw
 * HTTP body while it streams, before the upstream bundle parses it, so there is
 * no valid prefix to hand back: a cut-off JSON list would either fail to parse
 * or, worse, look like a complete answer ("these are all the alerts"). An error
 * that says how to ask for less is the safe outcome, so the message names the
 * tool's own narrowing parameters, read from its input schema.
 */
import { GENERATED_TOOLS } from "./generated/tools.js";

/**
 * What the upstream returns when the child's egress guard aborts a response: the
 * guard throws "Acronis response is larger than N bytes and was not read" from
 * `fetch`, and the upstream reports a failed request as `HTTP request failed: <message>`.
 * Anchored to the whole first text block: a real upstream error starts with
 * `HTTP <status>` and carries the response body after it, so a 400 whose body
 * happens to quote this text (a reflected request parameter, say) must not pass for it.
 */
export const OVERSIZE_PATTERN = /^HTTP request failed: Acronis response is larger than \d+ bytes and was not read$/;

export function isOversizeResult(result: { isError?: boolean; content?: unknown } | undefined): boolean {
  if (!result?.isError || !Array.isArray(result.content)) return false;
  const first = (result.content as Array<{ type?: string; text?: unknown }>).find((block) => block?.type === "text");
  return typeof first?.text === "string" && OVERSIZE_PATTERN.test(first.text);
}

// Parameter names that cut a list down, in the order they are suggested.
const PAGING = ["limit", "skip", "after", "before", "cursor"];
const SCOPE = [
  "tenant_id",
  "tenant",
  "customer_id",
  "parent_id",
  "subtree_root_id",
  "subtree_root_tenant_id",
  "target_tenant_id",
  "agent_id",
  "resource_id",
  "resourceId",
  "workload_id",
  "context_id",
  "policy_id",
];
const FILTER = [
  "severity",
  "type",
  "types",
  "category",
  "state",
  "status",
  "source",
  "enabled",
  "online",
  "os_family",
  "usage_names",
  "editions",
  "updated_since",
  "updated_at",
  "created_at",
  "search",
  "text",
  "query",
];

/** Tools with no narrowing parameter of their own, and the one that does the same job with them. */
const NARROWER: Record<string, string> = {
  acronis_fetch_tenant_users: "acronis_fetch_users_batch (set query.tenant_id, query.limit and query.after)",
  acronis_fetch_tenant_children: "acronis_fetch_tenants_batch (set query.parent_id, query.limit and query.after)",
};

const queryParams = new Map(
  GENERATED_TOOLS.map((t) => {
    const query = (t.tool.inputSchema as { properties?: Record<string, { properties?: Record<string, unknown> }> })
      .properties?.query;
    return [t.tool.name, new Set(Object.keys(query?.properties ?? {}))] as const;
  })
);

/** The error text for an oversize response from this (caller-facing) tool. */
export function oversizeMessage(toolName: string): string {
  const has = queryParams.get(toolName) ?? new Set<string>();
  const pick = (names: string[]) => names.filter((n) => has.has(n)).map((n) => `query.${n}`);
  const groups = [
    ["page it", pick(PAGING)],
    ["scope it", pick(SCOPE)],
    ["filter it", pick(FILTER)],
  ].filter(([, names]) => names.length > 0) as Array<[string, string[]]>;

  const advice = groups.length
    ? `Ask for less: ${groups.map(([how, names]) => `${how} with ${names.join(", ")}`).join("; ")}.`
    : "";
  const alternative = NARROWER[toolName]
    ? ` This tool cannot be narrowed; use ${NARROWER[toolName]} instead.`
    : groups.length
      ? ""
      : " This tool has no parameter that makes the answer smaller.";
  return (
    "Acronis returned more data than this connector reads in one call (over 256 KiB), so nothing was returned. " +
    "Do not treat this as an empty result. " +
    advice +
    alternative
  ).trim();
}
