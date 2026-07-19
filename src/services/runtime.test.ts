import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seedAgents } from "../data/seed";
import type { CodexSkill, McpServer } from "../domain";
import { getPlatformStatus, repairAccessibilityPermission, requestAccessibilityPermission, scanCodexEnvironment, startNativeRun } from "./runtime";

const platformStatus = {
  platform: "macos",
  supported: true,
  accessibilityTrusted: false,
  permissionRequired: "accessibility",
  implementation: "axuielement",
  monitorRunning: true,
  contextBarReady: true,
};

describe("Runtime IPC", () => {
  afterEach(() => clearMocks());

  it("checks permission without prompting", async () => {
    const handler = vi.fn(() => platformStatus);
    mockIPC(handler);

    await expect(getPlatformStatus()).resolves.toEqual(platformStatus);
    expect(handler).toHaveBeenCalledWith("platform_status", { prompt: false });
  });

  it("prompts only through the explicit request API", async () => {
    const handler = vi.fn(() => platformStatus);
    mockIPC(handler);

    await expect(requestAccessibilityPermission()).resolves.toEqual(platformStatus);
    expect(handler).toHaveBeenCalledWith("platform_status", { prompt: true });
  });

  it("repairs a stale macOS permission through an explicit IPC action", async () => {
    const handler = vi.fn(() => platformStatus);
    mockIPC(handler);

    await expect(repairAccessibilityPermission()).resolves.toEqual(platformStatus);
    expect(handler).toHaveBeenCalledWith("repair_accessibility_permission", {});
  });

  it("maps the complete app-server environment without seeded catalogs", async () => {
    const now = Math.floor(Date.now() / 1000);
    const handler = vi.fn(() => ({
      codexHome: "/Users/test/.codex",
      configPath: "/Users/test/.codex/config.toml",
      userAgent: "codex_cli_rs/0.144.2",
      models: [{ id: "dynamic", model: "dynamic", displayName: "Dynamic", description: "Server model", hidden: false, isDefault: true, supportedReasoningEfforts: [{ id: "ultra", description: "Deep" }], defaultReasoningEffort: "ultra", serviceTiers: [{ id: "priority", name: "Priority", description: "Faster" }], defaultServiceTier: null, inputModalities: ["text"], supportsPersonality: true }],
      effectiveConfig: { model: "dynamic", modelProvider: null, reasoningEffort: "ultra", serviceTier: "default", approvalPolicy: "on-request", sandboxMode: "workspace-write", permissionProfile: null },
      account: { signedIn: true, accountType: "chatgpt", planType: "plus", requiresOpenaiAuth: true },
      profiles: ["review"],
      mcpServers: [],
      skills: [],
      permissionProfiles: [{ id: ":workspace", description: null, allowed: true }],
      requirements: { allowedApprovalPolicies: null, allowedSandboxModes: null, allowedPermissionProfiles: null, defaultPermissions: null },
      providerCapabilities: { namespaceTools: true, imageGeneration: false, webSearch: true },
      experimentalFeatures: [],
      workspaces: [{ id: "/repo", name: "repo", path: "/repo", branch: "main", lastUsedAt: now }],
      errors: [],
    }));
    mockIPC(handler);

    const environment = await scanCodexEnvironment("/repo", "review");

    expect(handler).toHaveBeenCalledWith("scan_codex_environment", { workspacePath: "/repo", profile: "review" });
    expect(environment?.models[0].model).toBe("dynamic");
    expect(environment?.workspaces[0]).toMatchObject({ path: "/repo", branch: "main", lastUsed: "Now" });
  });

  it("resolves selected Skills and configurable MCP servers into native run input", async () => {
    const handler = vi.fn(() => ({ runId: "run-1", prompt: "prompt" }));
    mockIPC(handler);
    const agent = { ...seedAgents[0], enabledSkills: ["review"], enabledMcpServers: ["docs"] };
    const skills: CodexSkill[] = [{ id: "review", name: "Review", description: "Review code", source: "user", enabled: true, compatible: true, path: "/skills/review/SKILL.md", validationErrors: [] }];
    const mcps: McpServer[] = [{ id: "docs", name: "Docs", transport: "http", enabled: true, authentication: "none", source: "effective", health: "connected", detail: "5 tools", configurable: true, configPath: "/.codex/config.toml" }, { id: "managed", name: "Managed", transport: "managed", enabled: true, authentication: "none", source: "managed", health: "connected", detail: "1 tool", configurable: false, configPath: "/.codex/config.toml" }];

    await startNativeRun(agent, { selection: "Review this", application: "Editor" }, skills, mcps);

    expect(handler).toHaveBeenCalledWith("start_codex_run", expect.objectContaining({
      agent: expect.objectContaining({
        resolvedSkills: [{ id: "review", name: "Review", path: "/skills/review/SKILL.md" }],
        resolvedMcpServers: ["docs"],
      }),
      titleSource: expect.stringContaining(`Task: ${agent.name}`),
    }));
  });
});
