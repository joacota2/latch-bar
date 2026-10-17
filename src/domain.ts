export type NavKey =
  "agents" | "runs" | "mcps" | "skills" | "workspaces" | "settings";

export type SandboxMode = "read-only" | "workspace-write" | "full-access";
export type ApprovalPolicy = "always-ask" | "when-needed" | "never";
export type WorkspaceMode =
  "none" | "active-application" | "ask-each-time" | "fixed" | "recent-project";
export type RunStatus =
  "running" | "approval" | "completed" | "failed" | "cancelled";

export interface CodexReasoningEffort {
  id: string;
  description: string;
}

export interface CodexServiceTier {
  id: string;
  name: string;
  description: string;
}

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  supportedReasoningEfforts: CodexReasoningEffort[];
  defaultReasoningEffort: string | null;
  serviceTiers: CodexServiceTier[];
  defaultServiceTier: string | null;
  inputModalities: string[];
  supportsPersonality: boolean;
}

export interface CodexPermissionProfile {
  id: string;
  description: string | null;
  allowed: boolean;
}

export interface CodexEffectiveConfig {
  model: string | null;
  modelProvider: string | null;
  reasoningEffort: string | null;
  serviceTier: string | null;
  approvalPolicy: string | null;
  sandboxMode: string | null;
  permissionProfile: string | null;
}

export interface CodexAccount {
  signedIn: boolean;
  accountType: string | null;
  planType: string | null;
  requiresOpenaiAuth: boolean;
}

export interface CodexRequirements {
  allowedApprovalPolicies: string[] | null;
  allowedSandboxModes: string[] | null;
  allowedPermissionProfiles: Record<string, boolean> | null;
  defaultPermissions: string | null;
}

export interface CodexProviderCapabilities {
  namespaceTools: boolean;
  imageGeneration: boolean;
  webSearch: boolean;
}

export interface CodexExperimentalFeature {
  name: string;
  displayName: string | null;
  description: string | null;
  stage: string;
  enabled: boolean;
  defaultEnabled: boolean;
}

export interface CodexEnvironment {
  codexHome: string;
  configPath: string;
  userAgent: string;
  models: CodexModel[];
  effectiveConfig: CodexEffectiveConfig;
  account: CodexAccount;
  profiles: string[];
  mcpServers: McpServer[];
  skills: CodexSkill[];
  permissionProfiles: CodexPermissionProfile[];
  requirements: CodexRequirements;
  providerCapabilities: CodexProviderCapabilities;
  experimentalFeatures: CodexExperimentalFeature[];
  workspaces: Workspace[];
  errors: string[];
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export interface ContextPolicy {
  includeSelection: boolean;
  includeApplicationName: boolean;
  includeWindowTitle: boolean;
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
  serviceTier: string;
  sandbox: SandboxMode;
  permissionProfile?: string;
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
  transport: "stdio" | "http" | "managed";
  enabled: boolean;
  authentication: "none" | "environment" | "bearer" | "oauth" | "unknown";
  source:
    | "effective"
    | "user"
    | "profile"
    | "project"
    | "system"
    | "enterprise"
    | "session"
    | "managed";
  health: "unknown" | "connected" | "error" | "disabled";
  detail: string;
  configurable: boolean;
  configPath: string;
}

export interface CodexSkill {
  id: string;
  legacyId?: string;
  name: string;
  description: string;
  source: "user" | "repo" | "system" | "admin";
  enabled: boolean;
  compatible: boolean;
  pluginId?: string;
  path?: string;
  validationErrors: string[];
}

export interface Workspace {
  saved?: boolean;
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
  conversation?: ConversationMessage[];
}

export interface AppSettings {
  contextBarEnabled: boolean;
  selectionDelay: number;
  minimumCharacters: number;
  storeHistory: boolean;
  storeSelectedText: boolean;
  redactWindowTitles: boolean;
  excludedApplications: string[];
}

export interface NativeSelection {
  selectionId: string;
  text: string;
  application: string;
  windowTitle?: string;
  processId: number;
  bounds: { x: number; y: number; width: number; height: number };
  replacementCapability: "none" | "accessibility" | "clipboardPaste";
  replacementUnavailableReason?: string;
}
