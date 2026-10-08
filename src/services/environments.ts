import type { CodexAgent, CodexEnvironment, CodexSkill } from "../domain";
export interface EnvironmentEntry { status: "idle" | "loading" | "ready" | "unavailable" | "error"; environment: CodexEnvironment | null; error: string }
export const emptyEnvironment: EnvironmentEntry = { status: "idle", environment: null, error: "" };
export function environmentKey(workspace?: string, profile?: string) {
  const raw = workspace?.trim();
  const path = raw ? raw.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/" : null;
  const normalizedProfile = profile?.trim();
  return JSON.stringify([path, !normalizedProfile || normalizedProfile === "default" ? null : normalizedProfile]);
}
export function resolveSkillIds(ids: string[], skills: CodexSkill[]) {
  const unresolved: string[] = [];
  const resolved = ids.map((id) => {
    const exact = skills.find((skill) => skill.id === id);
    if (exact) { if (!exact.enabled || !exact.compatible || !exact.path) unresolved.push(id); return id; }
    const matches = skills.filter((skill) => skill.legacyId === id);
    if (matches.length === 1 && matches[0].enabled && matches[0].compatible && matches[0].path) return matches[0].id;
    unresolved.push(id); return id;
  });
  return { resolved: [...new Set(resolved)], unresolved };
}
export function validateRuntimeAgent(agent: CodexAgent, environment: CodexEnvironment) {
  const selected = resolveSkillIds(agent.enabledSkills, environment.skills);
  if (selected.unresolved.length) throw new Error("Reselect or remove unavailable Skills in the agent editor before running: " + selected.unresolved.join(", "));
  const missingMcp = agent.enabledMcpServers.filter((id) => !environment.mcpServers.some((server) => server.id === id && server.configurable));
  if (missingMcp.length) throw new Error("MCP servers are unavailable in this workspace/profile: " + missingMcp.join(", "));
  const requirements = environment.requirements;
  const approval = agent.approvalPolicy === "always-ask" ? "untrusted" : agent.approvalPolicy === "when-needed" ? "on-request" : "never";
  if (requirements?.allowedApprovalPolicies && !requirements.allowedApprovalPolicies.includes(approval)) throw new Error("The approval policy is prohibited by this Codex configuration");
  if (agent.permissionProfile && agent.permissionProfile !== "default") {
    if (!environment.permissionProfiles?.some((profile) => profile.id === agent.permissionProfile && profile.allowed) || requirements?.allowedPermissionProfiles?.[agent.permissionProfile] === false) throw new Error("The permission profile is unavailable in this context");
  } else if (requirements?.allowedSandboxModes && !requirements.allowedSandboxModes.includes(agent.sandbox === "full-access" ? "danger-full-access" : agent.sandbox)) throw new Error("The sandbox is prohibited by this Codex configuration");
  const model = environment.models.find((model) => agent.model === "default" ? model.model === environment.effectiveConfig?.model || model.isDefault : model.model === agent.model);
  if (agent.model !== "default" && !model) throw new Error("The selected model is unavailable in this workspace/profile. Refresh the catalog and reselect a model before running.");
  if (model && agent.reasoningEffort !== "default" && !model.supportedReasoningEfforts.some((effort) => effort.id === agent.reasoningEffort)) throw new Error("The selected reasoning effort is unavailable for this model");
  if (model && agent.serviceTier !== "default" && !model.serviceTiers.some((tier) => tier.id === agent.serviceTier)) throw new Error("The selected service tier is unavailable for this model");
  return { ...agent, enabledSkills: selected.resolved };
}
