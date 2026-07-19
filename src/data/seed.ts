import type { AppSettings, CodexAgent, Run } from "../domain";

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
    model: "default", reasoningEffort: "low", serviceTier: "default", sandbox: "read-only", approvalPolicy: "always-ask", workspaceMode: "none", enabledMcpServers: [], enabledSkills: [], contextPolicy: defaultContext, outputPolicy: output("preview", "plain-text"), createdAt: now, updatedAt: now,
  },
  {
    id: "staff-engineer", name: "Staff engineer", icon: "⌘", accent: "purple", enabled: true, pinned: true, order: 1,
    description: "Review technical work, expose risks, and propose the next move.",
    promptTemplate: "Act as a staff software engineer. Analyze the selected content, identify important technical risks, and propose a concrete implementation plan. Be direct and prioritize the highest-leverage changes.",
    model: "default", reasoningEffort: "high", serviceTier: "default", sandbox: "workspace-write", approvalPolicy: "when-needed", workspaceMode: "ask-each-time", enabledMcpServers: [], enabledSkills: [], contextPolicy: defaultContext, outputPolicy: output("open-studio", "markdown"), createdAt: now, updatedAt: now,
  },
  {
    id: "ui-reviewer", name: "UI reviewer", icon: "◈", accent: "orange", enabled: true, pinned: true, order: 2,
    description: "Find usability and visual hierarchy issues in interface specs.",
    promptTemplate: "Review the selected interface description as a senior product designer. Identify usability, hierarchy, accessibility, and interaction issues. Give specific, implementable recommendations.",
    model: "default", reasoningEffort: "medium", serviceTier: "default", sandbox: "read-only", approvalPolicy: "always-ask", workspaceMode: "none", enabledMcpServers: [], enabledSkills: [], contextPolicy: defaultContext, outputPolicy: output("preview", "markdown"), createdAt: now, updatedAt: now,
  },
  {
    id: "translate", name: "Translate to English", icon: "EN", accent: "blue", enabled: true, pinned: false, order: 3,
    description: "Translate while preserving tone, formatting, and intent.",
    promptTemplate: "Translate the selected content into natural English. Preserve its tone, structure, formatting, names, and exact meaning. Return only the translation.",
    model: "default", reasoningEffort: "low", serviceTier: "default", sandbox: "read-only", approvalPolicy: "always-ask", workspaceMode: "none", enabledMcpServers: [], enabledSkills: [], contextPolicy: defaultContext, outputPolicy: output("preview", "plain-text"), createdAt: now, updatedAt: now,
  },
  {
    id: "explain-error", name: "Explain error", icon: "?", accent: "red", enabled: true, pinned: false, order: 4,
    description: "Turn an error message into a likely cause and next checks.",
    promptTemplate: "Explain the selected error in plain language. Identify the most likely root cause, show the evidence in the message, then propose the smallest set of checks to confirm it.",
    model: "default", reasoningEffort: "medium", serviceTier: "default", sandbox: "read-only", approvalPolicy: "when-needed", workspaceMode: "recent-project", enabledMcpServers: [], enabledSkills: [], contextPolicy: defaultContext, outputPolicy: output("preview", "markdown"), createdAt: now, updatedAt: now,
  },
  {
    id: "plan-implementation", name: "Plan implementation", icon: "↗", accent: "teal", enabled: true, pinned: false, order: 5,
    description: "Convert selected requirements into a focused technical plan.",
    promptTemplate: "Convert the selected requirements into an implementation plan. Include scope, architecture decisions, ordered tasks, acceptance criteria, risks, and verification. Keep every task independently testable.",
    model: "default", reasoningEffort: "high", serviceTier: "default", sandbox: "read-only", approvalPolicy: "when-needed", workspaceMode: "ask-each-time", enabledMcpServers: [], enabledSkills: [], contextPolicy: defaultContext, outputPolicy: output("open-studio", "markdown"), createdAt: now, updatedAt: now,
  },
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
  excludedApplications: ["1Password", "Keychain Access"],
};
