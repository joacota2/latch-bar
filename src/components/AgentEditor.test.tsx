import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { seedAgents } from "../data/seed";
import type { CodexAgent } from "../domain";
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

  it("migrates replacement policy and keeps replace mode consistent when disabled", async () => {
    const legacyAgent = structuredClone(seedAgents[0]) as Omit<CodexAgent, "outputPolicy"> & {
      outputPolicy: Partial<CodexAgent["outputPolicy"]>;
    };
    delete legacyAgent.outputPolicy.allowReplace;
    legacyAgent.outputPolicy.mode = "replace";
    localStorage.setItem("latch-bar-state-v1", JSON.stringify({ agents: [legacyAgent], runs: [] }));
    mockIPC((command) => command === "scan_codex_environment" ? environment : undefined);
    const user = userEvent.setup();

    render(<LatchProvider><Harness /></LatchProvider>);
    await screen.findByRole("complementary", { name: "Agent editor" });
    await user.click(screen.getByRole("button", { name: "Result" }));

    const replacement = screen.getByRole("switch", { name: "Allow replacement" });
    expect(replacement).toHaveAttribute("aria-checked", "true");
    await user.click(replacement);
    expect(replacement).toHaveAttribute("aria-checked", "false");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const persisted = JSON.parse(localStorage.getItem("latch-bar-state-v1")!);
    expect(persisted.agents[0].outputPolicy).toMatchObject({
      mode: "preview",
      allowReplace: false,
    });
  });

  it("exports shareable JSON and imports it without replacing the local agent identity", async () => {
    const copied: string[] = [];
    mockIPC((command, payload) => {
      if (command === "scan_codex_environment") return environment;
      if (command === "copy_text" && payload && !Array.isArray(payload) && "text" in payload && typeof payload.text === "string") copied.push(payload.text);
      return undefined;
    });
    const user = userEvent.setup();
    render(<LatchProvider><Harness /></LatchProvider>);
    await screen.findByRole("complementary", { name: "Agent editor" });

    await user.click(screen.getByRole("button", { name: "JSON" }));
    const editor = screen.getByRole("textbox", { name: "Agent JSON configuration" });
    const exported = JSON.parse(editor.textContent || (editor as HTMLTextAreaElement).value);
    expect(exported).toMatchObject({ version: 1, agent: { name: "Improve writing" } });
    expect(exported.agent).not.toHaveProperty("id");
    expect(exported.agent).not.toHaveProperty("createdAt");

    await user.click(screen.getByRole("button", { name: "Copy JSON" }));
    await waitFor(() => expect(JSON.parse(copied[0])).toEqual(exported));

    exported.agent.name = "Shared teammate agent";
    exported.agent.description = "Imported from a shared JSON configuration.";
    exported.agent.promptTemplate = "Use the shared configuration.";
    fireEvent.change(editor, { target: { value: JSON.stringify(exported, null, 2) } });
    await user.click(screen.getByRole("button", { name: "Import & save" }));

    expect(await screen.findByRole("heading", { name: "Shared teammate agent" })).toBeInTheDocument();
    const persisted = JSON.parse(localStorage.getItem("latch-bar-state-v1")!);
    expect(persisted.agents.find((agent: CodexAgent) => agent.id === "improve-writing")).toMatchObject({
      name: "Shared teammate agent",
      description: "Imported from a shared JSON configuration.",
      promptTemplate: "Use the shared configuration.",
    });
  });
});

vi.mock("../services/persistence", async (original) => (await import("../test/browserPersistence")).browserPersistence(original));
