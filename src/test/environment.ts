import type { CodexEnvironment } from "../domain";
export const emptyCatalog: CodexEnvironment = {
  codexHome: "/test/.codex", configPath: "/test/.codex/config.toml", userAgent: "fixture", models: [],
  effectiveConfig: { model: null, modelProvider: null, reasoningEffort: null, serviceTier: null, approvalPolicy: null, sandboxMode: null, permissionProfile: null },
  account: { signedIn: true, accountType: null, planType: null, requiresOpenaiAuth: false },
  profiles: [], mcpServers: [], skills: [], permissionProfiles: [],
  requirements: { allowedApprovalPolicies: null, allowedSandboxModes: null, allowedPermissionProfiles: null, defaultPermissions: null },
  providerCapabilities: { namespaceTools: false, imageGeneration: false, webSearch: false }, experimentalFeatures: [], workspaces: [], errors: [],
};
