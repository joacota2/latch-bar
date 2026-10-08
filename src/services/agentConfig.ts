import { z } from "zod";
import type { CodexAgent } from "../domain";

const contextPolicySchema = z.object({
  includeSelection: z.boolean(),
  includeApplicationName: z.boolean(),
  includeWindowTitle: z.boolean(),
  includeWorkspaceMetadata: z.boolean(),
  maxSelectionCharacters: z.number().int().min(100).max(200_000),
  excludedApplications: z.array(z.string()),
});

const outputPolicySchema = z.object({
  mode: z.enum(["preview", "replace", "copy", "open-studio"]),
  allowReplace: z.boolean(),
  streamPreview: z.boolean(),
  expectedOutput: z.enum(["plain-text", "markdown", "code", "diff", "automatic"]),
});

export const agentConfigSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string(),
  icon: z.string().trim().min(1),
  accent: z.string().min(1),
  enabled: z.boolean(),
  pinned: z.boolean(),
  promptTemplate: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
  serviceTier: z.string(),
  sandbox: z.enum(["read-only", "workspace-write", "full-access"]),
  permissionProfile: z.string().optional(),
  approvalPolicy: z.enum(["always-ask", "when-needed", "never"]),
  workspaceMode: z.enum(["none", "active-application", "ask-each-time", "fixed", "recent-project"]),
  fixedWorkspacePath: z.string().optional(),
  enabledMcpServers: z.array(z.string()),
  enabledSkills: z.array(z.string()),
  contextPolicy: contextPolicySchema,
  outputPolicy: outputPolicySchema,
  codexProfile: z.string().optional(),
});

const sharedAgentConfigSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  agent: agentConfigSchema,
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

export function getAgentConfig(agent: CodexAgent): AgentConfig {
  return {
    name: agent.name,
    description: agent.description,
    icon: agent.icon,
    accent: agent.accent,
    enabled: agent.enabled,
    pinned: agent.pinned,
    promptTemplate: agent.promptTemplate,
    model: agent.model,
    reasoningEffort: agent.reasoningEffort,
    serviceTier: agent.serviceTier,
    sandbox: agent.sandbox,
    ...(agent.permissionProfile ? { permissionProfile: agent.permissionProfile } : {}),
    approvalPolicy: agent.approvalPolicy,
    workspaceMode: agent.workspaceMode,
    ...(agent.fixedWorkspacePath ? { fixedWorkspacePath: agent.fixedWorkspacePath } : {}),
    enabledMcpServers: agent.enabledMcpServers,
    enabledSkills: agent.enabledSkills,
    contextPolicy: { includeSelection: agent.contextPolicy.includeSelection, includeApplicationName: agent.contextPolicy.includeApplicationName, includeWindowTitle: agent.contextPolicy.includeWindowTitle, includeWorkspaceMetadata: agent.contextPolicy.includeWorkspaceMetadata, maxSelectionCharacters: agent.contextPolicy.maxSelectionCharacters, excludedApplications: agent.contextPolicy.excludedApplications },
    outputPolicy: agent.outputPolicy,
    ...(agent.codexProfile ? { codexProfile: agent.codexProfile } : {}),
  };
}

export function serializeAgentConfig(agent: CodexAgent) {
  return JSON.stringify({ version: 2, agent: getAgentConfig(agent) }, null, 2);
}

export function parseAgentConfig(json: string): AgentConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("The pasted value is not valid JSON.");
  }

  const result = sharedAgentConfigSchema.safeParse(parsed);
  if (result.success) return result.data.agent;

  // Accept the inner object too, which makes hand-authored configurations easy
  // to paste while keeping exported files explicitly versioned.
  const unwrapped = agentConfigSchema.safeParse(parsed);
  if (unwrapped.success) return unwrapped.data;

  const issue = result.error.issues[0];
  const path = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
  throw new Error(`Invalid agent configuration${path}: ${issue?.message ?? "unknown error"}`);
}

export function applyAgentConfig(agent: CodexAgent, config: AgentConfig): CodexAgent {
  return {
    ...agent,
    ...config,
    fixedWorkspacePath: config.fixedWorkspacePath,
    codexProfile: config.codexProfile,
    permissionProfile: config.permissionProfile,
    contextPolicy: { ...config.contextPolicy },
    outputPolicy: { ...config.outputPolicy },
    enabledMcpServers: [...config.enabledMcpServers],
    enabledSkills: [...config.enabledSkills],
  };
}
