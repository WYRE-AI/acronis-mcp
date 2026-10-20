#!/usr/bin/env node
// Generates src/generated/tools.ts from research/upstream-tools-1.0.1.json
// filtered by research/tiers.json. Run: npm run gen-tools
//
// - keeps the upstream inputSchema verbatim
// - description = first sentence, "[API name]" prefix stripped, max 300 chars
// - name = acronis_<upstream name>, or acronis_<NAME_OVERRIDES entry>
// - description = DESCRIPTION_OVERRIDES entry when present
// - writes the before/after tools/list byte sizes to stderr (recorded in README)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstream = JSON.parse(readFileSync(resolve(root, "research/upstream-tools-1.0.1.json"), "utf8")).tools;
const tiers = JSON.parse(readFileSync(resolve(root, "research/tiers.json"), "utf8"));

const MAX_DESC = 300;

/**
 * Caller-facing names for upstream tools whose generated name is unclear
 * (upstream name -> name after the acronis_ prefix). The child is still
 * called with the upstream name.
 */
const NAME_OVERRIDES = {
  fetch_partner_s_customer_alerts_count: "fetch_alert_counts_per_customer",
  fetch_tenant_mfastatus: "fetch_tenant_mfa_status",
  fetch_a_count_of_all_resources_that_match_filter_parameters: "fetch_resource_count",
  get_count_of_active_alerts_and_last_modification_time: "fetch_active_alert_count",
  fetch_resources_containing_the_highest_severity_alerts: "fetch_resources_with_top_severity_alerts",
  fetch_a_list_of_policies: "fetch_policies",
  fetch_a_policy: "fetch_policy",
  fetch_a_list_of_policy_applications: "fetch_policy_applications",
  fetch_a_list_of_all_resources: "fetch_resources",
  fetch_a_resource_by_id: "fetch_resource",
  fetch_an_alert_by_id: "fetch_alert",
  fetch_the_protection_status_of_resources: "fetch_resource_protection_status",
  execute_a_protection_policy: "execute_protection_policy",
};

/** Reviewed descriptions (copy review, 2026-10-20), keyed by final tool name. */
const DESCRIPTION_OVERRIDES = {
  acronis_fetch_tenants_batch: "Gets several tenants at once, by up to 100 tenant IDs, by parent tenant, or as a tenant and everything under it.",
  acronis_fetch_tenant_children: "Lists the IDs of the tenants directly under a tenant, such as a partner's customers.",
  acronis_fetch_users_batch: "Gets details for several users at once.",
  acronis_fetch_categories: "Lists the alert categories that are turned on.",
  acronis_fetch_alerts_grouped_by_scope: "Gets the most recent of the most severe alerts for each group, grouped by the scope you choose.",
  acronis_fetch_policies: "Lists protection policies (called protection plans in the Acronis console).",
  acronis_fetch_policy: "Gets one protection policy and its settings by ID.",
  acronis_fetch_policy_applications: "Lists where policies are applied, meaning which resources each policy covers, with optional filters.",
  acronis_fetch_applications_issue_statistics: "Counts problems with applied policies, grouped by issue.",
  acronis_fetch_application_statuses_by_policy: "Gets the status of every resource a given policy is applied to.",
  acronis_fetch_resources: "Lists resources (machines, mailboxes and other workloads), with optional filters.",
  acronis_fetch_resource: "Gets one resource (a machine, mailbox or other workload) by ID.",
  acronis_fetch_resource_protection_status: "Shows which resources are protected and which aren't.",
  acronis_fetch_agents: "Lists the Acronis agents installed on machines in a tenant.",
  acronis_fetch_agent: "Gets one Acronis agent by ID.",
  acronis_fetch_incidents: "Lists EDR security incidents, with optional filters.",
  acronis_fetch_incident: "Gets the details of one EDR security incident by ID.",
  acronis_fetch_response_action_status: "Gets the status of a response action that was started on an incident, such as isolating a machine.",
  acronis_mark_alert_as_false_positive: "Marks an alert as a false positive, or clears that mark. This changes the alert in Acronis for everyone.",
  acronis_update_investigation_state: "Changes an incident's investigation state, or adds a comment to the incident. The change is saved in Acronis.",
  acronis_execute_protection_policy: "Runs a protection policy right away on every resource it's applied to, which starts backup or protection jobs on those machines. Admin only.",
};


export function shortDescription(name, raw) {
  let text = String(raw ?? "").replace(/^\s*\[[^\]]*\]\s*/, "").trim();
  if (!text) {
    // Some upstream tools ship an empty description; fall back to the name.
    const words = name.replace(/_/g, " ");
    return words.charAt(0).toUpperCase() + words.slice(1) + ".";
  }
  // First sentence: up to the first sentence terminator followed by whitespace
  // or a newline, whichever comes first.
  const m = /^(.*?[.!?])(?=\s|$)/s.exec(text.split(/\n/)[0]) ;
  text = (m ? m[1] : text.split(/\n/)[0]).trim();
  if (text.length > MAX_DESC) text = text.slice(0, MAX_DESC - 1).trimEnd() + "…";
  return text;
}

const byName = new Map();
for (const t of upstream) {
  if (byName.has(t.name)) byName.set(t.name, null); // duplicate upstream name -> never exposable
  else byName.set(t.name, t);
}

const entries = [];
for (const tier of ["read", "write"]) {
  for (const name of tiers[tier]) {
    const t = byName.get(name);
    if (!t) throw new Error(`tier ${tier}: tool ${name} missing or duplicated upstream`);
    entries.push({
      upstream: name,
      tier,
      tool: {
        name: `acronis_${NAME_OVERRIDES[name] ?? name}`,
        description: DESCRIPTION_OVERRIDES[`acronis_${NAME_OVERRIDES[name] ?? name}`] ?? shortDescription(name, t.description),
        inputSchema: t.inputSchema,
        annotations:
          tier === "read"
            ? { readOnlyHint: true }
            : { readOnlyHint: false, destructiveHint: false },
      },
    });
  }
}

for (const key of Object.keys(NAME_OVERRIDES)) {
  if (!entries.some((e) => e.upstream === key)) throw new Error(`NAME_OVERRIDES: ${key} is not an allowlisted upstream tool`);
}
for (const key of Object.keys(DESCRIPTION_OVERRIDES)) {
  if (!entries.some((e) => e.tool.name === key)) throw new Error(`DESCRIPTION_OVERRIDES: ${key} matches no generated tool`);
}
const seen = new Set();
for (const e of entries) {
  if (seen.has(e.tool.name)) throw new Error(`duplicate tool name ${e.tool.name}`);
  seen.add(e.tool.name);
}

const before = Buffer.byteLength(JSON.stringify({ tools: upstream.filter((t) => byName.get(t.name) && entries.some((e) => e.upstream === t.name)) }));
const afterRead = Buffer.byteLength(JSON.stringify({ tools: entries.filter((e) => e.tier === "read").map((e) => e.tool) }));
const after = Buffer.byteLength(JSON.stringify({ tools: entries.map((e) => e.tool) }));
const full = Buffer.byteLength(JSON.stringify({ tools: upstream }));

const header = `// GENERATED by scripts/gen-tools.mjs from research/upstream-tools-1.0.1.json
// filtered by research/tiers.json. Do not edit by hand; run \`npm run gen-tools\`.
import type { Tool } from "@modelcontextprotocol/server";

export interface GeneratedTool {
  /** Upstream tool name, as called on the child process. */
  upstream: string;
  tier: "read" | "write";
  tool: Tool;
}

`;
const body = `export const GENERATED_TOOLS: GeneratedTool[] = ${JSON.stringify(entries, null, 2)};\n`;
mkdirSync(resolve(root, "src/generated"), { recursive: true });
writeFileSync(resolve(root, "src/generated/tools.ts"), header + body);

console.error(
  JSON.stringify({ upstreamAll159: full, upstream37Before: before, wrapped37After: after, wrappedReadOnly34After: afterRead, count: entries.length })
);
