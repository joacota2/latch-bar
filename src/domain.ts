export type NavKey = "agents" | "runs" | "mcps" | "skills" | "workspaces" | "settings";

export type SandboxMode = "read-only" | "workspace-write" | "full-access";
export type ApprovalPolicy = "always-ask" | "when-needed" | "never";
export type WorkspaceMode = "none" | "active-application" | "ask-each-time" | "fixed" | "recent-project";
export type RunStatus = "running" | "approval" | "completed" | "failed" | "cancelled";
export type ContextBarState = "idle" | "running" | "approval" | "result" | "error";

export interface ContextPolicy {
  includeSelection: boolean;
  includeApplicationName: boolean;
  includeWindowTitle: boolean;
  includeClipboard: boolean;
  includeScreenshot: boolean;
  includeWorkspaceMetadata: boolean;
  maxSelectionCharacters: number;
  excludedApplications: string[];
}

export interface OutputPolicy {
  mode: "preview" | "replace" | "copy" | "open-studio";
  allowReplace: boolean;
  streamPreview: boolean;
  expectedOutput: "plain-text" | "markdown" | "code" | "diff" | "automatic";
}

export interface CodexAgent {
  id: string;
  name: string;
  description: string;
  icon: string;
  accent: string;
  enabled: boolean;
  pinned: boolean;
  order: number;
  promptTemplate: string;
  model: string;
  reasoningEffort: string;
  speed: string;
  sandbox: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  workspaceMode: WorkspaceMode;
  fixedWorkspacePath?: string;
  enabledMcpServers: string[];
  enabledSkills: string[];
  contextPolicy: ContextPolicy;
  outputPolicy: OutputPolicy;
  codexProfile?: string;
  createdAt: string;
  updatedAt: string;
}

export interface McpServer {
  id: string;
  name: string;
  transport: "stdio" | "http";
  enabled: boolean;
  authentication: "none" | "environment" | "bearer" | "oauth" | "unknown";
  source: "global" | "project" | "managed";
  health: "unknown" | "connected" | "error";
  detail: string;
  configPath: string;
}

export interface CodexSkill {
  id: string;
  name: string;
  description: string;
  source: "global" | "workspace" | "plugin" | "managed";
  enabled: boolean;
  compatible: boolean;
  pluginId?: string;
  path?: string;
  validationErrors: string[];
}

export interface Workspace {
  id: string;
  name: string;
  path: string;
  branch: string;
  lastUsed: string;
  color: string;
}

export interface Run {
  id: string;
  agentId: string;
  agentName: string;
  agentIcon: string;
  status: RunStatus;
  sourceApplication: string;
  sourceIcon: string;
  workspacePath?: string;
  activity: string;
  model: string;
  sandbox: SandboxMode;
  duration?: string;
  startedAt: string;
  finalResponse?: string;
  command?: string;
  threadId?: string;
}

export interface AppSettings {
  launchAtLogin: boolean;
  showMenuBar: boolean;
  contextBarEnabled: boolean;
  selectionDelay: number;
  minimumCharacters: number;
  storeHistory: boolean;
  storeSelectedText: boolean;
  redactWindowTitles: boolean;
  codexHome: string;
  excludedApplications: string[];
}
