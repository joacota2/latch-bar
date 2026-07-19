import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { LatchProvider, useLatch } from "../store/LatchStore";
import { AgentEditor } from "./AgentEditor";

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => undefined),
}));

const environment = {
  codexHome: "/Users/test/.codex",
  configPath: "/Users/test/.codex/config.toml",
  userAgent: "codex_cli_rs/0.144.2",
  models: [
    {
      id: "catalog-default",
      model: "catalog-default",
      displayName: "Catalog Default",
      description: "Catalog fallback",
      hidden: false,
      isDefault: true,
      supportedReasoningEfforts: [{ id: "low", description: "Low" }],
      defaultReasoningEffort: "low",
      serviceTiers: [],
      defaultServiceTier: null,
      inputModalities: ["text"],
      supportsPersonality: true,
    },
    {
      id: "dynamic-model",
      model: "dynamic-model",
      displayName: "Dynamic Model",
      description: "Effective model discovered from Codex",
      hidden: false,
      isDefault: false,
      supportedReasoningEfforts: [{ id: "low", description: "Low" }, { id: "ultra", description: "Ultra" }],
      defaultReasoningEffort: "low",
      serviceTiers: [{ id: "priority", name: "Priority", description: "Faster processing" }],
      defaultServiceTier: null,
      inputModalities: ["text"],
      supportsPersonality: true,
    },
  ],
  effectiveConfig: { model: "dynamic-model", modelProvider: null, reasoningEffort: "low", serviceTier: "default", approvalPolicy: "on-request", sandboxMode: "read-only", permissionProfile: null },
  account: { signedIn: true, accountType: "chatgpt", planType: "plus", requiresOpenaiAuth: true },
  profiles: ["deep-review"],
  mcpServers: [{ id: "docs", name: "Docs", transport: "http", enabled: true, authentication: "none", source: "effective", health: "connected", detail: "5 tools", configurable: true, configPath: "/Users/test/.codex/config.toml" }],
  skills: [{ id: "review", name: "Review", description: "Review code", source: "user", enabled: true, compatible: true, path: "/skills/review/SKILL.md", validationErrors: [] }],
  permissionProfiles: [{ id: ":read-only", description: null, allowed: true }, { id: "custom-safe", description: "Custom safe profile", allowed: true }],
  requirements: { allowedApprovalPolicies: ["on-request"], allowedSandboxModes: ["read-only"], allowedPermissionProfiles: { ":read-only": false, "custom-safe": true }, defaultPermissions: "custom-safe" },
  providerCapabilities: { namespaceTools: true, imageGeneration: false, webSearch: true },
  experimentalFeatures: [],
  workspaces: [{ id: "/repo", name: "repo", path: "/repo", branch: "main", lastUsedAt: Math.floor(Date.now() / 1000) }],
  errors: [],
};

function Harness() {
  const { setSelectedAgentId } = useLatch();
  useEffect(() => setSelectedAgentId("improve-writing"), [setSelectedAgentId]);
  return <AgentEditor />;
}

describe("Codex-discovered agent options", () => {
  afterEach(() => { cleanup(); clearMocks(); localStorage.clear(); });

  it("renders model capabilities, profiles, permissions, MCPs, and Skills from app-server", async () => {
    mockIPC((command) => command === "scan_codex_environment" ? environment : undefined);
    const user = userEvent.setup();
    render(<LatchProvider><Harness /></LatchProvider>);
    await screen.findByRole("complementary", { name: "Agent editor" });

    await user.click(screen.getByRole("button", { name: "Runtime" }));
    const modelSelect = screen.getByRole("combobox", { name: "Model" });
    await waitFor(() => expect(within(modelSelect).getByRole("option", { name: "Dynamic Model" })).toBeInTheDocument());
    expect(within(modelSelect).queryByRole("option", { name: "gpt-5.4" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ultra" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Priority" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "deep-review" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Access" }));
    expect(screen.getByRole("button", { name: /custom safe profile/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Read only/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ask before tool use/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Ask when elevated access is needed/ })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: /MCPs & Skills/ }));
    expect(screen.getByRole("button", { name: /Docs/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Review/ })).toBeInTheDocument();
  });
});
