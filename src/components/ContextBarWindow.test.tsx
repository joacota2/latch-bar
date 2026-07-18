import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeSelection } from "../domain";
import { seedAgents, seedSettings } from "../data/seed";
import { LatchProvider } from "../store/LatchStore";
import { ContextBarWindow } from "./ContextBarWindow";

type EventHandler = (event: { payload: unknown }) => void;

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, EventHandler>(),
  continueNativeRun: vi.fn(),
  startNativeRun: vi.fn(),
  stopNativeRun: vi.fn(),
  setOverlayPinned: vi.fn(),
  hideContextBar: vi.fn(),
  resizeContextBar: vi.fn(),
  setContextBarFocusable: vi.fn(),
  focusSelectionApplication: vi.fn(),
  openStudio: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async (event: string, handler: EventHandler) => {
    mocks.listeners.set(event, handler);
    return () => mocks.listeners.delete(event);
  }),
}));

vi.mock("../services/runtime", () => ({
  continueNativeRun: mocks.continueNativeRun,
  copyNativeText: vi.fn(async () => undefined),
  focusSelectionApplication: mocks.focusSelectionApplication,
  hideContextBar: mocks.hideContextBar,
  interruptNativeRun: vi.fn(async () => undefined),
  isTauri: vi.fn(() => true),
  markContextBarReady: vi.fn(async () => undefined),
  openStudio: mocks.openStudio,
  replaceNativeSelection: vi.fn(async () => ({ method: "accessibility" })),
  resizeContextBar: mocks.resizeContextBar,
  setContextBarFocusable: mocks.setContextBarFocusable,
  respondToApproval: vi.fn(async () => undefined),
  scanCodexEnvironment: vi.fn(async () => null),
  setOverlayPinned: mocks.setOverlayPinned,
  startNativeRun: mocks.startNativeRun,
  stopNativeRun: mocks.stopNativeRun,
}));

const selection = (text: string, x: number): NativeSelection => ({
  text,
  application: "TextEdit",
  windowTitle: "Draft",
  processId: 42,
  bounds: { x, y: 80, width: 120, height: 20 },
});

function emit(event: string, payload: unknown) {
  const handler = mocks.listeners.get(event);
  if (!handler) throw new Error(`Missing ${event} listener`);
  act(() => handler({ payload }));
}

describe("Context Bar lifecycle", () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.listeners.clear();
    vi.clearAllMocks();
    mocks.startNativeRun
      .mockResolvedValueOnce({ runId: "run-1", prompt: "first" })
      .mockResolvedValueOnce({ runId: "run-2", prompt: "second" });
    mocks.continueNativeRun.mockResolvedValue(undefined);
    mocks.stopNativeRun.mockResolvedValue(undefined);
    mocks.setOverlayPinned.mockResolvedValue(undefined);
    mocks.hideContextBar.mockResolvedValue(undefined);
    mocks.resizeContextBar.mockResolvedValue(undefined);
    mocks.setContextBarFocusable.mockResolvedValue(undefined);
    mocks.focusSelectionApplication.mockResolvedValue(undefined);
    mocks.openStudio.mockResolvedValue(undefined);
  });

  afterEach(cleanup);

  it("finishes inside the bar and accepts another selection without restarting", async () => {
    const user = userEvent.setup();
    render(<LatchProvider><ContextBarWindow /></LatchProvider>);
    await waitFor(() => expect(mocks.listeners.has("native-selection")).toBe(true));

    emit("native-selection", selection("First selection", 20));
    await user.click(screen.getByText("Staff"));

    await waitFor(() => expect(mocks.startNativeRun).toHaveBeenCalledTimes(1));
    expect(mocks.startNativeRun.mock.calls[0][0]).toMatchObject({
      id: "staff-engineer",
      workspaceMode: "none",
    });

    emit("codex-event", {
      runId: "run-1",
      message: {
        method: "turn/completed",
        params: { turn: { status: "completed", items: [{ type: "agentMessage", text: "The answer stays in the Context Bar." }] } },
      },
    });

    expect(await screen.findByText("The answer stays in the Context Bar.")).toBeInTheDocument();
    expect(mocks.stopNativeRun).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.setOverlayPinned).toHaveBeenLastCalledWith(false));

    emit("native-selection", selection("Second selection", 260));
    await waitFor(() => expect(mocks.stopNativeRun).toHaveBeenCalledWith("run-1"));
    await user.click(await screen.findByText("Improve"));
    await waitFor(() => expect(mocks.startNativeRun).toHaveBeenCalledTimes(2));
  });

  it("expands for streaming and continues with extra instructions without opening Studio", async () => {
    const user = userEvent.setup();
    render(<LatchProvider><ContextBarWindow /></LatchProvider>);
    await waitFor(() => expect(mocks.listeners.has("native-selection")).toBe(true));

    emit("native-selection", selection("A sentence to improve", 20));
    await user.click(screen.getByRole("button", { name: "Run Improve writing" }));

    expect(await screen.findByText("Streaming response in Latch")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Continue/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Cancel/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Replace/ })).toBeDisabled();
    expect(screen.getByText("Codex is preparing the response…").closest("article")).toHaveClass("context-chat-message", "assistant", "is-streaming");
    expect(mocks.openStudio).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.resizeContextBar).toHaveBeenCalledWith(300));

    emit("codex-event", {
      runId: "run-1",
      message: {
        method: "turn/completed",
        params: { turn: { status: "completed", items: [{ type: "agentMessage", text: "Improved sentence." }] } },
      },
    });
    await screen.findByText("Improved sentence.");
    await user.click(screen.getByRole("button", { name: /Continue/ }));
    const input = screen.getByRole("textbox", { name: "Additional instructions" });
    await user.type(input, "Make it friendlier");
    await user.click(within(input.closest("form")!).getByRole("button", { name: /Continue/ }));

    await waitFor(() => expect(mocks.continueNativeRun).toHaveBeenCalledWith("run-1", "Make it friendlier"));
    expect(mocks.startNativeRun).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Make it friendlier").closest("article")).toHaveClass("context-chat-message", "user");

    emit("codex-event", {
      runId: "run-1",
      message: {
        method: "turn/completed",
        params: { turn: { status: "completed", items: [{ type: "agentMessage", text: "A friendlier sentence." }] } },
      },
    });
    expect(await screen.findByText("A friendlier sentence.")).toBeInTheDocument();
    expect(screen.getByText("Improved sentence.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Continue/ }));
    const secondInput = screen.getByRole("textbox", { name: "Additional instructions" });
    await user.type(secondInput, "Now make it shorter");
    await user.click(within(secondInput.closest("form")!).getByRole("button", { name: /Continue/ }));
    await waitFor(() => expect(mocks.continueNativeRun).toHaveBeenCalledWith("run-1", "Now make it shorter"));
    expect(screen.getByText("Now make it shorter")).toBeInTheDocument();
    expect(mocks.focusSelectionApplication).toHaveBeenLastCalledWith(42);
    expect(mocks.openStudio).not.toHaveBeenCalled();
  });

  it("updates pinned agents live and opens the agent picker without opening Studio", async () => {
    const user = userEvent.setup();
    render(<LatchProvider><ContextBarWindow /></LatchProvider>);
    await waitFor(() => expect(mocks.listeners.has("latch-state-changed")).toBe(true));
    emit("native-selection", selection("Selected text", 20));

    emit("latch-state-changed", {
      agents: seedAgents.map((agent) => agent.id === "translate" ? { ...agent, pinned: true } : agent),
      runs: [],
      settings: seedSettings,
    });
    expect(await screen.findByRole("button", { name: "Run Translate to English" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Choose another agent" }));
    const picker = screen.getByRole("menu", { name: "All agents" });
    expect(within(picker).getByRole("button", { name: "Run Plan implementation" })).toBeInTheDocument();
    expect(mocks.openStudio).not.toHaveBeenCalled();
    expect(mocks.focusSelectionApplication).not.toHaveBeenCalled();

    const translateButton = within(picker).getByRole("button", { name: "Run Translate to English" });
    await user.hover(translateButton);
    expect(translateButton.closest(".context-agent-option")).toHaveClass("is-hovered");
    const pinButton = within(picker).getByRole("button", { name: "Unpin Translate to English" });
    await user.click(pinButton);
    expect(await within(picker).findByRole("button", { name: "Pin Translate to English" })).toBeInTheDocument();
    expect(screen.queryAllByRole("button", { name: "Run Translate to English" })).toHaveLength(1);
    await user.click(translateButton);
    expect(translateButton.closest(".context-agent-option")).toHaveClass("is-launching");
    await waitFor(() => expect(mocks.startNativeRun).toHaveBeenCalledTimes(1));
    expect(mocks.openStudio).not.toHaveBeenCalled();
  });
});
