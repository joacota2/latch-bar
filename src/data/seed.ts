import type { AppSettings, CodexAgent, CodexSkill, McpServer, Run, Workspace } from "../domain";

const now = new Date().toISOString();
const defaultContext = {
  includeSelection: true,
  includeApplicationName: true,
  includeWindowTitle: false,
  includeClipboard: false,
  includeScreenshot: false,
  includeWorkspaceMetadata: true,
  maxSelectionCharacters: 50_000,
  excludedApplications: [],
};

const output = (mode: CodexAgent["outputPolicy"]["mode"], expectedOutput: CodexAgent["outputPolicy"]["expectedOutput"] = "automatic") => ({
  mode,
  allowReplace: mode !== "open-studio",
  streamPreview: true,
  expectedOutput,
});

export const seedAgents: CodexAgent[] = [
  {
    id: "improve-writing", name: "Improve writing", icon: "✦", accent: "lime", enabled: true, pinned: true, order: 0,
    description: "Make selected writing clearer, sharper, and easier to read.",
    promptTemplate: "Rewrite the selected text to improve clarity and flow. Preserve the meaning, concrete details, original language, and formatting where possible. Return only the final text.",
    model: "default", reasoningEffort: "low", speed: "fast", sandbox: "read-only", approvalPolicy: "always-ask", workspaceMode: "none", enabledMcpServers: [], enabledSkills: ["technical-writing"], contextPolicy: defaultContext, outputPolicy: output("preview", "plain-text"), createdAt: now, updatedAt: now,
  },
  {
    id: "staff-engineer", name: "Staff engineer", icon: "⌘", accent: "purple", enabled: true, pinned: true, order: 1,
    description: "Review technical work, expose risks, and propose the next move.",
    promptTemplate: "Act as a staff software engineer. Analyze the selected content, identify important technical risks, and propose a concrete implementation plan. Be direct and prioritize the highest-leverage changes.",
    model: "default", reasoningEffort: "high", speed: "standard", sandbox: "workspace-write", approvalPolicy: "when-needed", workspaceMode: "ask-each-time", enabledMcpServers: ["github", "linear"], enabledSkills: ["code-review", "testing", "architecture"], contextPolicy: defaultContext, outputPolicy: output("open-studio", "markdown"), createdAt: now, updatedAt: now,
  },
  {
    id: "ui-reviewer", name: "UI reviewer", icon: "◈", accent: "orange", enabled: true, pinned: true, order: 2,
    description: "Find usability and visual hierarchy issues in interface specs.",
    promptTemplate: "Review the selected interface description as a senior product designer. Identify usability, hierarchy, accessibility, and interaction issues. Give specific, implementable recommendations.",
    model: "default", reasoningEffort: "medium", speed: "standard", sandbox: "read-only", approvalPolicy: "always-ask", workspaceMode: "none", enabledMcpServers: [], enabledSkills: ["visualize"], contextPolicy: defaultContext, outputPolicy: output("preview", "markdown"), createdAt: now, updatedAt: now,
  },
  {
    id: "translate", name: "Translate to English", icon: "EN", accent: "blue", enabled: true, pinned: false, order: 3,
    description: "Translate while preserving tone, formatting, and intent.",
    promptTemplate: "Translate the selected content into natural English. Preserve its tone, structure, formatting, names, and exact meaning. Return only the translation.",
    model: "default", reasoningEffort: "low", speed: "fast", sandbox: "read-only", approvalPolicy: "always-ask", workspaceMode: "none", enabledMcpServers: [], enabledSkills: [], contextPolicy: defaultContext, outputPolicy: output("preview", "plain-text"), createdAt: now, updatedAt: now,
  },
  {
    id: "explain-error", name: "Explain error", icon: "?", accent: "red", enabled: true, pinned: false, order: 4,
    description: "Turn an error message into a likely cause and next checks.",
    promptTemplate: "Explain the selected error in plain language. Identify the most likely root cause, show the evidence in the message, then propose the smallest set of checks to confirm it.",
    model: "default", reasoningEffort: "medium", speed: "standard", sandbox: "read-only", approvalPolicy: "when-needed", workspaceMode: "recent-project", enabledMcpServers: [], enabledSkills: ["code-review"], contextPolicy: defaultContext, outputPolicy: output("preview", "markdown"), createdAt: now, updatedAt: now,
  },
  {
    id: "plan-implementation", name: "Plan implementation", icon: "↗", accent: "teal", enabled: true, pinned: false, order: 5,
    description: "Convert selected requirements into a focused technical plan.",
    promptTemplate: "Convert the selected requirements into an implementation plan. Include scope, architecture decisions, ordered tasks, acceptance criteria, risks, and verification. Keep every task independently testable.",
    model: "default", reasoningEffort: "high", speed: "standard", sandbox: "read-only", approvalPolicy: "when-needed", workspaceMode: "ask-each-time", enabledMcpServers: ["github"], enabledSkills: ["architecture", "testing"], contextPolicy: defaultContext, outputPolicy: output("open-studio", "markdown"), createdAt: now, updatedAt: now,
  },
];

export const seedMcps: McpServer[] = [
  { id: "github", name: "GitHub", transport: "stdio", enabled: true, authentication: "environment", source: "global", health: "connected", detail: "Local process · 18 tools", configPath: "~/.codex/config.toml" },
  { id: "linear", name: "Linear", transport: "http", enabled: true, authentication: "oauth", source: "global", health: "connected", detail: "Remote · OAuth connected", configPath: "~/.codex/config.toml" },
  { id: "openai-docs", name: "OpenAI Docs", transport: "http", enabled: true, authentication: "none", source: "global", health: "connected", detail: "Remote · Read only", configPath: "~/.codex/config.toml" },
  { id: "analytics", name: "Internal analytics", transport: "http", enabled: false, authentication: "bearer", source: "project", health: "unknown", detail: "Project · Authentication required", configPath: ".codex/config.toml" },
];

export const seedSkills: CodexSkill[] = [
  { id: "code-review", name: "Code review", description: "Review changes for correctness, maintainability, and regressions.", source: "global", enabled: true, compatible: true, path: "~/.codex/skills/code-review/SKILL.md", validationErrors: [] },
  { id: "testing", name: "Testing", description: "Design focused tests and verify behavior across the full slice.", source: "global", enabled: true, compatible: true, path: "~/.codex/skills/testing/SKILL.md", validationErrors: [] },
  { id: "architecture", name: "Architecture", description: "Evaluate boundaries, trade-offs, and durable system design.", source: "workspace", enabled: true, compatible: true, path: ".agents/skills/architecture/SKILL.md", validationErrors: [] },
  { id: "technical-writing", name: "Technical writing", description: "Write clear technical documents for a specific audience.", source: "plugin", pluginId: "knowledge-work", enabled: true, compatible: true, validationErrors: [] },
  { id: "visualize", name: "Visualize", description: "Create interface maps, diagrams, and interactive explanations.", source: "plugin", pluginId: "visualize", enabled: true, compatible: true, validationErrors: [] },
  { id: "release-prep", name: "Release preparation", description: "Prepare a validated release summary and checklist.", source: "global", enabled: false, compatible: true, path: "~/.codex/skills/release-prep/SKILL.md", validationErrors: [] },
];

export const seedWorkspaces: Workspace[] = [
  { id: "latch", name: "Latch Bar", path: "~/Projects/latch-bar", branch: "main", lastUsed: "Now", color: "#c8f46a" },
  { id: "acme", name: "Acme Web", path: "~/Projects/acme-web", branch: "feature/billing", lastUsed: "2h ago", color: "#9b8afc" },
  { id: "mobile", name: "Mobile App", path: "~/Projects/mobile", branch: "develop", lastUsed: "Yesterday", color: "#f6a969" },
];

export const seedRuns: Run[] = [];

export const seedSettings: AppSettings = {
  launchAtLogin: true,
  showMenuBar: true,
  contextBarEnabled: true,
  selectionDelay: 220,
  minimumCharacters: 3,
  storeHistory: true,
  storeSelectedText: false,
  redactWindowTitles: true,
  codexHome: "~/.codex",
  excludedApplications: ["1Password", "Keychain Access"],
};
