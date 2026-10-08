import type { Run } from "../domain";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { DEFAULT_AGENTS_VERSION, seedAgents, seedSettings } from "../data/seed";
import { LatchProvider, useLatch } from "../store/LatchStore";
import { unavailableUpdate } from "../services/updates";
const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  reveal: vi.fn(),
  open: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(
    async (name: string, cb: (event: { payload: unknown }) => void) => {
      mocks.listeners.set(name, cb);
      return () => mocks.listeners.delete(name);
    },
  ),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: mocks.reveal,
  openUrl: mocks.open,
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
      supportedReasoningEfforts: [
        { id: "low", description: "Low" },
        { id: "ultra", description: "Ultra" },
      ],
      defaultReasoningEffort: "low",
      serviceTiers: [
        { id: "priority", name: "Priority", description: "Faster processing" },
      ],
      defaultServiceTier: null,
      inputModalities: ["text"],
      supportsPersonality: true,
    },
  ],
  effectiveConfig: {
    model: "dynamic-model",
    modelProvider: null,
    reasoningEffort: "low",
    serviceTier: "default",
    approvalPolicy: "on-request",
    sandboxMode: "read-only",
    permissionProfile: null,
  },
  account: {
    signedIn: true,
    accountType: "chatgpt",
    planType: "plus",
    requiresOpenaiAuth: true,
  },
  profiles: ["deep-review"],
  mcpServers: [
    {
      id: "docs",
      name: "Docs",
      transport: "http",
      enabled: true,
      authentication: "none",
      source: "effective",
      health: "connected",
      detail: "5 tools",
      configurable: true,
      configPath: "/Users/test/.codex/config.toml",
    },
  ],
  skills: [
    {
      id: "review",
      name: "Review",
      description: "Review code",
      source: "user",
      enabled: true,
      compatible: true,
      path: "/skills/review/SKILL.md",
      validationErrors: [],
    },
  ],
  permissionProfiles: [
    { id: ":read-only", description: null, allowed: true },
    { id: "custom-safe", description: "Custom safe profile", allowed: true },
  ],
  requirements: {
    allowedApprovalPolicies: ["on-request"],
    allowedSandboxModes: ["read-only"],
    allowedPermissionProfiles: { ":read-only": false, "custom-safe": true },
    defaultPermissions: "custom-safe",
  },
  providerCapabilities: {
    namespaceTools: true,
    imageGeneration: false,
    webSearch: true,
  },
  experimentalFeatures: [],
  workspaces: [
    {
      id: "/repo",
      name: "repo",
      path: "/repo",
      branch: "main",
      lastUsedAt: Math.floor(Date.now() / 1000),
    },
  ],
  errors: [],
};

const key = "latch-bar-state-v1";
let current: typeof environment;
let handler: ReturnType<typeof vi.fn<(command: string) => unknown>>;
let store: ReturnType<typeof useLatch>;
const run = (id = "history"): Run => ({
  id,
  agentId: "improve-writing",
  agentName: "History QA",
  agentIcon: "H",
  status: "completed",
  sourceApplication: "Fixture",
  sourceIcon: "F",
  activity: "Done",
  model: "fixture",
  sandbox: "read-only",
  startedAt: "now",
  finalResponse: "EXACT 😀 RESPONSE",
  threadId: "qa /#?",
});
function Harness() {
  store = useLatch();
  return <App />;
}
async function mount() {
  const view = render(
    <LatchProvider>
      <Harness />
    </LatchProvider>,
  );
  await waitFor(() =>
    expect(store.ready && store.environmentStatus === "ready").toBe(true),
  );
  return view;
}
async function editor() {
  await mount();
  act(() => store.setSelectedAgentId("improve-writing"));
  await screen.findByRole("complementary", { name: "Agent editor" });
}
const click = async (name: string | RegExp) =>
  userEvent.click(screen.getByRole("button", { name }));
const preset = (patch: Record<string, unknown> = {}) =>
  localStorage.setItem(
    key,
    JSON.stringify({
      defaultAgentsVersion: DEFAULT_AGENTS_VERSION,
      agents: seedAgents,
      settings: seedSettings,
      runs: [],
      ...patch,
    }),
  );
beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  mocks.listeners.clear();
  mocks.reveal.mockReset().mockResolvedValue(undefined);
  mocks.open.mockReset().mockResolvedValue(undefined);
  current = structuredClone(environment);
  handler = vi.fn((command) => {
    if (command === "scan_codex_environment") return current;
    if (command === "update_state") return unavailableUpdate;
    if (command === "platform_status")
      return { supported: false, accessibilityTrusted: false };
    if (command === "codex_status")
      return { available: true, version: "fixture" };
    if (command === "start_codex_run")
      return { runId: "fixture", prompt: "prompt" };
    return undefined;
  });
  mockIPC(handler);
});
afterEach(() => {
  cleanup();
  clearMocks();
});
describe("Studio functional regressions", () => {
  it("HIS-06 exact historical copy and rejected clipboard toast", async () => {
    preset({ runs: [run()] });
    await mount();
    await click("Runs");
    await click(/History QA.*Done/);
    const copy = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("denied"));
    await click("Copy");
    expect(copy).toHaveBeenCalledWith("EXACT 😀 RESPONSE");
    await click("Copy");
    expect(
      await screen.findByText(/Could not copy the result/),
    ).toBeInTheDocument();
  });
  it.each(["MCPs", "Settings"])(
    "CAT-11 %s reveal succeeds and fails visibly",
    async (page) => {
      await mount();
      await click(page);
      if (page === "Settings") await click("Codex");
      const target = () =>
        screen.getByRole("button", {
          name:
            page === "MCPs" ? "Open config" : "/Users/test/.codex/config.toml",
        });
      await userEvent.click(target());
      expect(mocks.reveal).toHaveBeenCalledWith(current.configPath);
      mocks.reveal.mockRejectedValueOnce(new Error("unavailable"));
      await userEvent.click(target());
      expect(
        await screen.findByText(/Could not show the Codex configuration file/),
      ).toBeInTheDocument();
      current.configPath = "";
      await act(async () => {
        await store.refreshCodexEnvironment();
      });
      expect(
        screen.getByRole("button", {
          name: page === "MCPs" ? "Open config" : "",
        }),
      ).toBeDisabled();
    },
  );
  it("keeps Settings focused on implemented features", async () => {
    await mount();
    await click("Settings");
    expect(
      screen.queryByRole("button", { name: "Advanced" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: "Launch at login" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: "Show menu bar icon" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Enable Context Bar" }),
    ).toBeEnabled();
    await click("Codex");
    expect(screen.getByRole("button", { name: "Check status" })).toBeEnabled();
  });
  it("GAP-14 Learn opens usable help", async () => {
    await mount();
    await click("Learn how it works");
    expect(
      screen.getByRole("dialog", { name: "Using Latch Bar" }),
    ).toBeInTheDocument();
  });
  it.each(["Save changes", "Save & test with selection"])(
    "GAP-01 %s rejects blank names without success or closing",
    async (button) => {
      await editor();
      fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
        target: { value: "  " },
      });
      await click(button);
      expect(screen.getByRole("alert")).toHaveTextContent("name");
      expect(store.agents[0].name).toBe("Improve writing");
      expect(
        screen.getByRole("complementary", { name: "Agent editor" }),
      ).toBeInTheDocument();
      expect(screen.queryByText("Agent saved")).not.toBeInTheDocument();
    },
  );
  it.each([0, 99, 200001, 101.5])(
    "GAP-01 invalid character limit %s is rejected",
    async (limit) => {
      await editor();
      await click("Context");
      fireEvent.change(
        screen.getByRole("spinbutton", {
          name: "Maximum selection characters",
        }),
        { target: { value: String(limit) } },
      );
      await click("Save changes");
      expect(screen.getByRole("alert")).toHaveTextContent(
        "maxSelectionCharacters",
      );
      expect(store.agents[0].contextPolicy.maxSelectionCharacters).toBe(
        seedAgents[0].contextPolicy.maxSelectionCharacters,
      );
    },
  );
  it("GAP-03 selected history detail reflects completion and disappears on reset", async () => {
    preset({
      runs: [{ ...run(), status: "running", finalResponse: undefined }],
    });
    await mount();
    await click("Runs");
    await click(/History QA.*Running/);
    await act(async () => {
      await store.upsertRun({
        ...run(),
        finalResponse: "NEW COMPLETED ANSWER",
      });
    });
    expect(screen.getByText("NEW COMPLETED ANSWER")).toBeInTheDocument();
    await act(async () => {
      await store.clearData();
    });
    expect(screen.queryByText("NEW COMPLETED ANSWER")).not.toBeInTheDocument();
  });
});
vi.mock("../services/persistence", async (original) =>
  (await import("./browserPersistence")).browserPersistence(original),
);
