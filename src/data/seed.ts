import type { AppSettings, CodexAgent, Run } from "../domain";

const now = new Date().toISOString();
const defaultContext = {
  includeSelection: true,
  includeApplicationName: true,
  includeWindowTitle: false,
  includeWorkspaceMetadata: false,
  maxSelectionCharacters: 50_000,
  excludedApplications: [],
};

const output = (expectedOutput: CodexAgent["outputPolicy"]["expectedOutput"], allowReplace = false): CodexAgent["outputPolicy"] => ({
  mode: "preview",
  allowReplace,
  streamPreview: true,
  expectedOutput,
});

export const DEFAULT_AGENTS_VERSION = 1;

export const seedAgents: CodexAgent[] = [
  {
    id: "improve-writing", name: "Improve writing", icon: "✦", accent: "lime", enabled: true, pinned: true, order: 0,
    description: "Make selected writing clearer, sharper, and easier to read.",
    promptTemplate: "Rewrite the selected text to improve clarity, grammar, and flow. Preserve the meaning, concrete details, original language, voice, and formatting where possible. Do not add facts or commitments. Return only the final text.",
    model: "default", reasoningEffort: "low", serviceTier: "default", sandbox: "read-only", approvalPolicy: "always-ask", workspaceMode: "none", enabledMcpServers: [], enabledSkills: [], contextPolicy: defaultContext, outputPolicy: output("plain-text", true), createdAt: now, updatedAt: now,
  },
  {
    id: "summarize", name: "Summarize", icon: "≡", accent: "purple", enabled: true, pinned: true, order: 1,
    description: "Get the main takeaway and key points from selected text.",
    promptTemplate: "Summarize the selected text in its original language. Start with a concise takeaway, then add a few key points only when the length and complexity warrant them. Keep the summary substantially shorter than the source. Preserve important names, numbers, dates, decisions, and caveats. Use only information in the selection; do not invent missing context or add advice. Return only the summary.",
    model: "default", reasoningEffort: "low", serviceTier: "default", sandbox: "read-only", approvalPolicy: "always-ask", workspaceMode: "none", enabledMcpServers: [], enabledSkills: [], contextPolicy: defaultContext, outputPolicy: output("markdown"), createdAt: now, updatedAt: now,
  },
  {
    id: "explain-simply", name: "Explain simply", icon: "?", accent: "orange", enabled: true, pinned: true, order: 2,
    description: "Understand unfamiliar terms, dense text, or confusing messages.",
    promptTemplate: "Explain the selected text in clear, everyday language for someone unfamiliar with the subject. Respond in the original language. Explain the main meaning and any essential unfamiliar terms; use a brief example only if it helps. Keep the explanation concise and respectful. Distinguish what the text says from your interpretation, and acknowledge missing context instead of guessing. For an error message, explain its likely meaning and simple next checks without assuming access to a project.",
    model: "default", reasoningEffort: "medium", serviceTier: "default", sandbox: "read-only", approvalPolicy: "always-ask", workspaceMode: "none", enabledMcpServers: [], enabledSkills: [], contextPolicy: defaultContext, outputPolicy: output("markdown"), createdAt: now, updatedAt: now,
  },
  {
    id: "translate", name: "Translate to English", icon: "EN", accent: "blue", enabled: true, pinned: false, order: 3,
    description: "Translate while preserving tone, formatting, and intent.",
    promptTemplate: "Translate the selected content into natural English. Preserve its tone, structure, formatting, names, and exact meaning. Return only the translation.",
    model: "default", reasoningEffort: "low", serviceTier: "default", sandbox: "read-only", approvalPolicy: "always-ask", workspaceMode: "none", enabledMcpServers: [], enabledSkills: [], contextPolicy: defaultContext, outputPolicy: output("plain-text", true), createdAt: now, updatedAt: now,
  },
  {
    id: "draft-reply", name: "Draft a reply", icon: "↩", accent: "teal", enabled: true, pinned: false, order: 4,
    description: "Draft a thoughtful response to a selected email or message.",
    promptTemplate: "Treat the selected text as an incoming message and draft a concise, natural reply in the same language, matching its level of formality. Address the main questions or requests. Do not invent personal facts, availability, decisions, promises, or commitments on the user's behalf. If a useful reply depends on an unknown decision or fact, ask one brief clarification question instead of guessing. Otherwise return only the reply, ready to copy. Draft text only; do not send messages.",
    model: "default", reasoningEffort: "low", serviceTier: "default", sandbox: "read-only", approvalPolicy: "always-ask", workspaceMode: "none", enabledMcpServers: [], enabledSkills: [], contextPolicy: defaultContext, outputPolicy: output("plain-text"), createdAt: now, updatedAt: now,
  },
];

export const seedRuns: Run[] = [];

export const seedSettings: AppSettings = {
  contextBarEnabled: true,
  selectionDelay: 220,
  minimumCharacters: 3,
  storeHistory: true,
  storeSelectedText: false,
  redactWindowTitles: true,
  excludedApplications: ["1Password", "Keychain Access"],
};
