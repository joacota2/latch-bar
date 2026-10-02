import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeSelection } from "../domain";
import { DEFAULT_AGENTS_VERSION, seedAgents, seedSettings } from "../data/seed";
import { LatchProvider } from "../store/LatchStore";
import { ContextBarWindow } from "../components/ContextBarWindow";

type EventHandler = (event: { payload: unknown }) => void;

const mocks = vi.hoisted(() => ({
  respondToApproval: vi.fn(),
  scanCodexEnvironment: vi.fn(),
  chooseWorkspaceFolder: vi.fn(),
  listeners: new Map<string, EventHandler>(),
  copyNativeText: vi.fn(),
  continueNativeRun: vi.fn(),
  startNativeRun: vi.fn(),
  stopNativeRun: vi.fn(),
  setOverlayPinned: vi.fn(),
  hideContextBar: vi.fn(),
  resizeContextBar: vi.fn(),
  setContextBarFocusable: vi.fn(),
  focusSelectionApplication: vi.fn(),
  openStudio: vi.fn(),
  replaceNativeSelection: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async (event: string, handler: EventHandler) => {
    mocks.listeners.set(event, handler);
    return () => {
      if (mocks.listeners.get(event) === handler) mocks.listeners.delete(event);
    };
  }),
}));

vi.mock("../services/runtime", () => ({
  chooseWorkspaceFolder: mocks.chooseWorkspaceFolder,
  continueNativeRun: mocks.continueNativeRun,
  copyNativeText: mocks.copyNativeText,
  focusSelectionApplication: mocks.focusSelectionApplication,
  hideContextBar: mocks.hideContextBar,
  interruptNativeRun: vi.fn(async () => undefined),
  isTauri: vi.fn(() => true),
  markContextBarReady: vi.fn(async () => undefined),
  openStudio: mocks.openStudio,
  replaceNativeSelection: mocks.replaceNativeSelection,
  resizeContextBar: mocks.resizeContextBar,
  setContextBarFocusable: mocks.setContextBarFocusable,
  respondToApproval: mocks.respondToApproval,
  scanCodexEnvironment: mocks.scanCodexEnvironment,
  setOverlayPinned: mocks.setOverlayPinned,
  startNativeRun: mocks.startNativeRun,
  stopNativeRun: mocks.stopNativeRun,
}));

const selection = (
  text: string,
  x: number,
  replacementCapability: NativeSelection["replacementCapability"] = "accessibility",
): NativeSelection => ({
  selectionId: `selection-${x}`,
  text,
  application: "TextEdit",
  windowTitle: "Draft",
  processId: 42,
  bounds: { x, y: 80, width: 120, height: 20 },
  replacementCapability,
});

function emit(event: string, payload: unknown) {
  const handler = mocks.listeners.get(event);
  if (!handler) throw new Error(`Missing ${event} listener`);
  if (event === "latch-state-changed")
    localStorage.setItem(
      "latch-bar-state-v1",
      JSON.stringify({
        ...(payload as object),
        defaultAgentsVersion: DEFAULT_AGENTS_VERSION,
      }),
    );
  act(() => handler({ payload }));
}

describe("Context Bar lifecycle", () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.listeners.clear();
    vi.clearAllMocks();
    mocks.startNativeRun
      .mockReset()
      .mockResolvedValueOnce({ runId: "run-1", prompt: "first" })
      .mockResolvedValueOnce({ runId: "run-2", prompt: "second" });
    mocks.respondToApproval.mockReset().mockResolvedValue(undefined);
    mocks.scanCodexEnvironment.mockReset().mockResolvedValue(null);
    mocks.chooseWorkspaceFolder.mockReset().mockResolvedValue(null);
    mocks.copyNativeText.mockResolvedValue(undefined);
    mocks.continueNativeRun.mockResolvedValue(undefined);
    mocks.stopNativeRun.mockResolvedValue(undefined);
    mocks.setOverlayPinned.mockResolvedValue(undefined);
    mocks.hideContextBar.mockResolvedValue(undefined);
    mocks.resizeContextBar.mockResolvedValue(undefined);
    mocks.setContextBarFocusable.mockResolvedValue(undefined);
    mocks.focusSelectionApplication.mockResolvedValue(undefined);
    mocks.openStudio.mockResolvedValue(undefined);
    mocks.replaceNativeSelection
      .mockReset()
      .mockResolvedValue({ method: "accessibility", verified: true });
  });

  afterEach(cleanup);

  const key = "latch-bar-state-v1";
  const env = {
    models: [],
    mcpServers: [],
    skills: [],
    workspaces: [],
    profiles: [],
    errors: [],
  };
  const configure = (agent = {}, settings = {}, extra = {}) =>
    localStorage.setItem(
      key,
      JSON.stringify({
        defaultAgentsVersion: DEFAULT_AGENTS_VERSION,
        agents: [{ ...seedAgents[0], ...agent }],
        runs: [],
        settings: { ...seedSettings, ...settings },
        ...extra,
      }),
    );
  const message = (message: unknown) =>
    emit("codex-event", { runId: "run-1", message });
  const mount = async () => {
    render(
      <LatchProvider>
        <ContextBarWindow />
      </LatchProvider>,
    );
    await waitFor(() =>
      expect(mocks.listeners.has("native-selection")).toBe(true),
    );
    emit("native-selection", selection("QA selection 😀", 20));
  };
  const launch = async () => {
    await mount();
    await userEvent.click(
      screen.getByRole("button", { name: "Run Improve writing" }),
    );
    await waitFor(() => expect(mocks.startNativeRun).toHaveBeenCalled());
  };
  it("GAP-02 most recent prefers latest discovered project [acceptance]", async () => {
    configure(
      { workspaceMode: "recent-project" },
      {},
      {
        savedWorkspaces: [
          { id: "saved", name: "Saved", path: "/tmp/saved-old" },
        ],
      },
    );
    mocks.scanCodexEnvironment.mockResolvedValue({
      ...env,
      workspaces: [
        { id: "latest", name: "Latest", path: "/tmp/discovered-new" },
      ],
    });
    await launch();
    expect(mocks.startNativeRun.mock.calls[0][0].fixedWorkspacePath).toBe(
      "/tmp/discovered-new",
    );
  });
  it.each(["running", "approval"])(
    "GAP-04 open Studio terminalizes %s history [acceptance]",
    async (state) => {
      await launch();
      if (state === "approval")
        message({
          id: 55,
          method: "item/commandExecution/requestApproval",
          params: { command: "fixture" },
        });
      await userEvent.click(
        screen.getByRole("button", { name: "Open in Studio" }),
      );
      await waitFor(() => expect(mocks.stopNativeRun).toHaveBeenCalled());
      expect(JSON.parse(localStorage.getItem(key)!).runs[0].status).toBe(
        "cancelled",
      );
    },
  );
  it("GAP-05 launch failure has history [acceptance]", async () => {
    mocks.startNativeRun
      .mockReset()
      .mockRejectedValue(new Error("FIXTURE LAUNCH FAILURE"));
    await launch();
    expect(
      await screen.findByText("FIXTURE LAUNCH FAILURE"),
    ).toBeInTheDocument();
    expect(
      JSON.parse(localStorage.getItem(key) ?? '{"runs":[]}').runs,
    ).toHaveLength(1);
  });
  it("GAP-12 approval-delivery rejection displays actionable error [acceptance]", async () => {
    await launch();
    message({
      id: 55,
      method: "item/commandExecution/requestApproval",
      params: { command: "fixture" },
    });
    mocks.respondToApproval.mockRejectedValueOnce(
      new Error("APPROVAL DELIVERY FAILED"),
    );
    await userEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(screen.queryByText(/APPROVAL DELIVERY FAILED/)).toBeInTheDocument();
  });
  it("GAP-06 reset hides active output and ignores queued runtime events", async () => {
    await launch();
    message({
      method: "item/agentMessage/delta",
      params: { delta: "Private output" },
    });
    expect(screen.getByText("Private output")).toBeInTheDocument();
    const previous = JSON.parse(localStorage.getItem(key)!);
    emit("latch-state-changed", {
      agents: seedAgents,
      settings: seedSettings,
      runs: [],
      savedWorkspaces: [],
      __revision: previous.__revision + 1,
      __epoch: "new-reset-session",
    });
    await waitFor(() =>
      expect(mocks.stopNativeRun).toHaveBeenCalledWith("run-1"),
    );
    await waitFor(() =>
      expect(screen.queryByText("Private output")).not.toBeInTheDocument(),
    );
    message({
      method: "turn/completed",
      params: {
        turn: {
          status: "completed",
          items: [{ type: "agentMessage", text: "Late private answer" }],
        },
      },
    });
    await act(async () => {});
    expect(JSON.parse(localStorage.getItem(key)!).runs).toEqual([]);
    expect(screen.queryByText("Late private answer")).not.toBeInTheDocument();
  });
  it("GAP-11 pausing approval stops the child and records cancellation", async () => {
    await launch();
    message({
      id: 55,
      method: "item/commandExecution/requestApproval",
      params: { command: "fixture" },
    });
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(key)!).runs[0].status).toBe(
        "approval",
      ),
    );
    const state = JSON.parse(localStorage.getItem(key)!);
    emit("latch-state-changed", {
      ...state,
      settings: { ...state.settings, contextBarEnabled: false },
    });
    await waitFor(() =>
      expect(mocks.stopNativeRun).toHaveBeenCalledWith("run-1"),
    );
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(key)!).runs[0].status).toBe(
        "cancelled",
      ),
    );
    expect(
      screen.queryByRole("button", { name: "Deny" }),
    ).not.toBeInTheDocument();
  });
  it("GAP-12 failed delivery keeps approval reachable and retry succeeds", async () => {
    await launch();
    message({
      id: 55,
      method: "item/commandExecution/requestApproval",
      params: { command: "fixture" },
    });
    mocks.respondToApproval.mockRejectedValueOnce(new Error("Offline"));
    await userEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Offline");
    expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(key)!).runs[0].status).toBe(
        "running",
      ),
    );
  });
  it("GAP-05 workspace failure before native launch records a failed attempt", async () => {
    configure({ workspaceMode: "fixed", fixedWorkspacePath: "" });
    await mount();
    await userEvent.click(
      screen.getByRole("button", { name: "Run Improve writing" }),
    );
    await screen.findByText(
      "Choose a fixed workspace in the agent settings first",
    );
    expect(mocks.startNativeRun).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(key)!).runs[0]).toMatchObject({
      status: "failed",
      agentId: "improve-writing",
    });
  });
});
vi.mock("../services/persistence", async (original) =>
  (await import("./browserPersistence")).browserPersistence(original),
);
