import { emptyCatalog } from "../test/environment";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeSelection } from "../domain";
import { DEFAULT_AGENTS_VERSION, seedAgents, seedSettings } from "../data/seed";
import { LatchProvider } from "../store/LatchStore";
import { ContextBarWindow } from "./ContextBarWindow";
import * as persistence from "../services/persistence";

type EventHandler = (event: { payload: unknown }) => void;

const mocks = vi.hoisted(() => ({
  chooseWorkspaceFolder: vi.fn(),
  markContextBarReady: vi.fn(async () => undefined),
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

vi.mock("../services/transientResults", () => ({
  handoffResult: vi.fn(async () => {
    await mocks.openStudio(true);
  }),
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
  markContextBarReady: mocks.markContextBarReady,
  openStudio: mocks.openStudio,
  replaceNativeSelection: mocks.replaceNativeSelection,
  resizeContextBar: mocks.resizeContextBar,
  setContextBarFocusable: mocks.setContextBarFocusable,
  respondToApproval: vi.fn(async () => undefined),
  scanCodexEnvironment: vi.fn(async () => emptyCatalog),
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

async function mountContextBar() {
  const view = render(
    <LatchProvider>
      <ContextBarWindow />
    </LatchProvider>,
  );
  await waitFor(() => expect(mocks.markContextBarReady).toHaveBeenCalledOnce());
  return view;
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

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("announces readiness only after persisted state and selection listeners are ready", async () => {
    const snapshot = persistence.browserSnapshot();
    let resolveState!: (value: typeof snapshot) => void;
    vi.spyOn(persistence, "readState").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveState = resolve;
        }),
    );
    render(
      <LatchProvider>
        <ContextBarWindow />
      </LatchProvider>,
    );
    await waitFor(() => expect(persistence.readState).toHaveBeenCalledOnce());

    expect(mocks.listeners.has("latch-state-changed")).toBe(true);
    expect(mocks.listeners.has("native-selection")).toBe(false);
    expect(mocks.markContextBarReady).not.toHaveBeenCalled();

    await act(async () => resolveState(snapshot));
    await waitFor(() =>
      expect(mocks.markContextBarReady).toHaveBeenCalledOnce(),
    );
    expect(mocks.listeners.has("native-selection")).toBe(true);
    expect(mocks.listeners.has("codex-event")).toBe(true);
    emit("native-selection", selection("Selected after loading", 20));
    expect(
      screen.getByRole("button", { name: "Run Improve writing" }),
    ).toBeInTheDocument();
  });

  it("finishes inside the bar and accepts another selection without restarting", async () => {
    const user = userEvent.setup();
    await mountContextBar();

    emit("native-selection", selection("First selection", 20));
    await user.click(
      screen.getByRole("button", { name: "Run Improve writing" }),
    );

    await waitFor(() => expect(mocks.startNativeRun).toHaveBeenCalledTimes(1));
    expect(mocks.startNativeRun.mock.calls[0][0]).toMatchObject({
      id: "improve-writing",
      workspaceMode: "none",
    });

    emit("codex-event", {
      runId: "run-1",
      message: {
        method: "turn/completed",
        params: {
          turn: {
            status: "completed",
            items: [
              {
                type: "agentMessage",
                text: "The answer stays in the Context Bar.",
              },
            ],
          },
        },
      },
    });

    expect(
      await screen.findByText("The answer stays in the Context Bar."),
    ).toBeInTheDocument();
    expect(mocks.stopNativeRun).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(mocks.setOverlayPinned).toHaveBeenLastCalledWith(true),
    );

    emit("native-selection", selection("Second selection", 260));
    expect(
      screen.getByRole("button", { name: "Run Improve writing" }),
    ).not.toHaveClass("is-hovered");
    await waitFor(() =>
      expect(mocks.stopNativeRun).toHaveBeenCalledWith("run-1"),
    );
    await user.click(
      await screen.findByRole("button", { name: "Run Improve writing" }),
    );
    await waitFor(() => expect(mocks.startNativeRun).toHaveBeenCalledTimes(2));
  });

  it("does not let a late continuation command response downgrade a completed result", async () => {
    const user = userEvent.setup();
    await mountContextBar();
    emit("native-selection", selection("Original", 20));
    await user.click(
      screen.getByRole("button", { name: "Run Improve writing" }),
    );
    await waitFor(() => expect(mocks.startNativeRun).toHaveBeenCalled());
    const complete = (text: string) =>
      emit("codex-event", {
        runId: "run-1",
        message: {
          method: "turn/completed",
          params: {
            turn: {
              status: "completed",
              items: [{ type: "agentMessage", text }],
            },
          },
        },
      });
    complete("First answer");
    await screen.findByText("First answer");
    let release!: () => void;
    mocks.continueNativeRun.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    const input = screen.getByRole("textbox", {
      name: "Additional instructions",
    });
    await user.type(input, "Again");
    await user.click(
      within(input.closest("form")!).getByRole("button", { name: "Continue" }),
    );
    await waitFor(() => expect(mocks.continueNativeRun).toHaveBeenCalled());
    complete("Second answer");
    await screen.findByText("Second answer");
    await act(async () => release());
    await waitFor(() =>
      expect(
        JSON.parse(localStorage.getItem("latch-bar-state-v1")!).runs[0],
      ).toMatchObject({ status: "completed", finalResponse: "Second answer" }),
    );
  });

  it("expands for streaming and continues with extra instructions without opening Studio", async () => {
    const user = userEvent.setup();
    await mountContextBar();

    emit("native-selection", selection("A sentence to improve", 20));
    await user.click(
      screen.getByRole("button", { name: "Run Improve writing" }),
    );

    expect(
      await screen.findByText("Streaming response in Latch"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Continue/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Cancel/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Replace/ })).toBeDisabled();
    expect(
      screen
        .getByText("Your agent is preparing the response…")
        .closest("article"),
    ).toHaveClass("context-chat-message", "assistant", "is-streaming");
    expect(mocks.openStudio).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(mocks.resizeContextBar).toHaveBeenCalledWith(300, 660, 80),
    );

    emit("codex-event", {
      runId: "run-1",
      message: {
        method: "turn/completed",
        params: {
          turn: {
            status: "completed",
            items: [{ type: "agentMessage", text: "Improved sentence." }],
          },
        },
      },
    });
    await screen.findByText("Improved sentence.");
    expect(
      screen.getByText("A sentence to improve").closest("article"),
    ).toHaveClass("context-chat-message", "user");
    await user.click(
      screen.getByRole("button", { name: "Copy selected text" }),
    );
    expect(mocks.copyNativeText).toHaveBeenLastCalledWith(
      "A sentence to improve",
    );
    await user.click(
      screen.getByRole("button", { name: "Copy Improve writing response" }),
    );
    expect(mocks.copyNativeText).toHaveBeenLastCalledWith("Improved sentence.");
    await user.click(screen.getByRole("button", { name: /Continue/ }));
    const input = screen.getByRole("textbox", {
      name: "Additional instructions",
    });
    await user.type(input, "Make it friendlier");
    await user.click(
      within(input.closest("form")!).getByRole("button", { name: /Continue/ }),
    );

    await waitFor(() =>
      expect(mocks.continueNativeRun).toHaveBeenCalledWith(
        "run-1",
        "Make it friendlier",
      ),
    );
    expect(mocks.startNativeRun).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText("Make it friendlier").closest("article"),
    ).toHaveClass("context-chat-message", "user");
    await user.click(screen.getByRole("button", { name: "Copy your message" }));
    expect(mocks.copyNativeText).toHaveBeenLastCalledWith("Make it friendlier");

    emit("codex-event", {
      runId: "run-1",
      message: {
        method: "turn/completed",
        params: {
          turn: {
            status: "completed",
            items: [{ type: "agentMessage", text: "A friendlier sentence." }],
          },
        },
      },
    });
    expect(
      await screen.findByText("A friendlier sentence."),
    ).toBeInTheDocument();
    expect(screen.getByText("Improved sentence.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Continue/ }));
    const secondInput = screen.getByRole("textbox", {
      name: "Additional instructions",
    });
    await user.type(secondInput, "Now make it shorter");
    await user.click(
      within(secondInput.closest("form")!).getByRole("button", {
        name: /Continue/,
      }),
    );
    await waitFor(() =>
      expect(mocks.continueNativeRun).toHaveBeenCalledWith(
        "run-1",
        "Now make it shorter",
      ),
    );
    expect(screen.getByText("Now make it shorter")).toBeInTheDocument();
    expect(mocks.focusSelectionApplication).toHaveBeenLastCalledWith(42);
    expect(mocks.openStudio).not.toHaveBeenCalled();
  });

  it("updates pinned agents live and opens the agent picker without opening Studio", async () => {
    const user = userEvent.setup();
    await mountContextBar();
    emit("native-selection", selection("Selected text", 20));

    emit("latch-state-changed", {
      agents: seedAgents.map((agent) =>
        agent.id === "translate" ? { ...agent, pinned: true } : agent,
      ),
      runs: [],
      settings: seedSettings,
    });
    expect(
      await screen.findByRole("button", { name: "Run Translate to English" }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Choose another agent" }),
    );
    const picker = screen.getByRole("menu", { name: "All agents" });
    expect(
      within(picker).getByRole("button", { name: "Run Draft a reply" }),
    ).toBeInTheDocument();
    expect(mocks.openStudio).not.toHaveBeenCalled();
    expect(mocks.focusSelectionApplication).not.toHaveBeenCalled();

    const translateButton = within(picker).getByRole("button", {
      name: "Run Translate to English",
    });
    await user.hover(translateButton);
    expect(translateButton.closest(".context-agent-option")).toHaveClass(
      "is-hovered",
    );
    const pinButton = within(picker).getByRole("button", {
      name: "Unpin Translate to English",
    });
    await user.click(pinButton);
    expect(
      await within(picker).findByRole("button", {
        name: "Pin Translate to English",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryAllByRole("button", { name: "Run Translate to English" }),
    ).toHaveLength(1);
    await user.click(translateButton);
    expect(translateButton.closest(".context-agent-option")).toHaveClass(
      "is-launching",
    );
    await waitFor(() => expect(mocks.startNativeRun).toHaveBeenCalledTimes(1));
    expect(mocks.openStudio).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "clears the previous agent hover on a new selection (closed: %s)",
    async (closeFirst) => {
      const user = userEvent.setup();
      await mountContextBar();
      emit("native-selection", selection("First selection", 20));
      const oldButton = screen.getByRole("button", { name: "Run Summarize" });
      await user.hover(oldButton);
      expect(oldButton).toHaveClass("is-hovered");
      if (closeFirst)
        await user.click(screen.getByRole("button", { name: /^Close$/ }));
      emit("native-selection", selection("Another selection", 260));
      const nextButton = screen.getByRole("button", { name: "Run Summarize" });
      expect(nextButton).not.toHaveClass("is-hovered");
      expect(nextButton).not.toHaveClass("is-native-hovered");
      expect(nextButton).not.toBe(oldButton);
      await user.hover(nextButton);
      expect(nextButton).toHaveClass("is-hovered");
    },
  );

  it("clears DOM hover when the native pointer leaves without a pointerleave event", async () => {
    const user = userEvent.setup();
    await mountContextBar();
    emit("native-selection", selection("Selected text", 20));
    const button = screen.getByRole("button", { name: "Run Summarize" });
    await user.hover(button);
    expect(button).toHaveClass("is-hovered");
    emit("context-pointer-position", { inside: false, x: 0, y: 0 });
    expect(button).not.toHaveClass("is-hovered");
  });

  it("keeps crowded pins icon-only and exposes the remainder without widening indefinitely", async () => {
    const user = userEvent.setup();
    await mountContextBar();
    emit("native-selection", selection("Selected text", 20));

    const crowdedAgents = Array.from({ length: 10 }, (_, index) => ({
      ...seedAgents[index % seedAgents.length],
      id: `pinned-${index + 1}`,
      name: `Pinned agent ${index + 1}`,
      icon: String(index + 1),
      pinned: true,
      order: index,
    }));
    emit("latch-state-changed", {
      agents: crowdedAgents,
      runs: [],
      settings: seedSettings,
    });

    await screen.findByRole("button", { name: "Show 3 more pinned agents" });
    const bar = screen.getByRole("region", { name: "Latch Context Bar" });
    const compactPins = bar.querySelectorAll(
      ".context-pinned-agents .context-action",
    );
    expect(compactPins).toHaveLength(7);
    expect(compactPins[0]).toHaveAttribute("data-agent-name", "Pinned agent 1");
    expect(compactPins[0]).toHaveTextContent("1Pinned agent 1");
    expect(
      compactPins[0].querySelector(".context-agent-tooltip"),
    ).toHaveTextContent("Pinned agent 1");
    expect(bar.closest(".context-wrap")).not.toHaveClass(
      "context-surface-glass",
    );
    expect(
      screen.getByRole("button", { name: "Show 3 more pinned agents" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.resizeContextBar).toHaveBeenCalledWith(86, 413, 80),
    );

    await user.click(
      screen.getByRole("button", { name: "Show 3 more pinned agents" }),
    );
    expect(
      within(screen.getByRole("menu", { name: "All agents" })).getAllByRole(
        "button",
        { name: /Run Pinned agent/ },
      ),
    ).toHaveLength(10);
  });

  it("disables replacement for a read-only selection", async () => {
    const user = userEvent.setup();
    await mountContextBar();

    emit("native-selection", selection("Read-only website text", 20, "none"));
    await user.click(
      screen.getByRole("button", { name: "Run Improve writing" }),
    );
    await waitFor(() => expect(mocks.startNativeRun).toHaveBeenCalledTimes(1));
    emit("codex-event", {
      runId: "run-1",
      message: {
        method: "turn/completed",
        params: {
          turn: {
            status: "completed",
            items: [{ type: "agentMessage", text: "A polished answer." }],
          },
        },
      },
    });

    const replace = await screen.findByRole("button", { name: /Replace/ });
    expect(replace).toBeDisabled();
    expect(replace).toHaveAttribute("title", "The selected text is read-only");
    await user.click(replace);
    expect(mocks.replaceNativeSelection).not.toHaveBeenCalled();
  });

  it("enforces an agent that has replacement disabled", async () => {
    const user = userEvent.setup();
    await mountContextBar();

    emit("latch-state-changed", {
      agents: seedAgents.map((agent) =>
        agent.id === "improve-writing"
          ? {
              ...agent,
              outputPolicy: { ...agent.outputPolicy, allowReplace: false },
            }
          : agent,
      ),
      runs: [],
      settings: seedSettings,
    });
    await waitFor(() => {
      expect(mocks.listeners.has("native-selection")).toBe(true);
      expect(mocks.listeners.has("codex-event")).toBe(true);
    });
    emit("native-selection", selection("Editable text", 20, "accessibility"));
    await user.click(
      await screen.findByRole("button", { name: "Run Improve writing" }),
    );
    await waitFor(() => expect(mocks.startNativeRun).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.listeners.has("codex-event")).toBe(true));
    emit("codex-event", {
      runId: "run-1",
      message: {
        method: "turn/completed",
        params: {
          turn: {
            status: "completed",
            items: [{ type: "agentMessage", text: "A polished answer." }],
          },
        },
      },
    });

    const replace = await screen.findByRole("button", { name: /Replace/ });
    expect(replace).toBeDisabled();
    expect(replace).toHaveAttribute(
      "title",
      "Replacement is disabled for Improve writing",
    );
    await user.click(replace);
    expect(mocks.replaceNativeSelection).not.toHaveBeenCalled();
  });

  it("replaces an editable selection when the agent allows it", async () => {
    const user = userEvent.setup();
    await mountContextBar();

    emit(
      "native-selection",
      selection("Editable custom control", 20, "clipboardPaste"),
    );
    await user.click(
      screen.getByRole("button", { name: "Run Improve writing" }),
    );
    await waitFor(() => expect(mocks.startNativeRun).toHaveBeenCalledTimes(1));
    emit("codex-event", {
      runId: "run-1",
      message: {
        method: "turn/completed",
        params: {
          turn: {
            status: "completed",
            items: [{ type: "agentMessage", text: "Replacement text." }],
          },
        },
      },
    });

    await screen.findByText("Replacement text.");
    const replace = screen.getByRole("button", { name: /Replace/ });
    await waitFor(() => expect(replace).toBeEnabled());
    await user.click(replace);
    await waitFor(() =>
      expect(mocks.replaceNativeSelection).toHaveBeenCalledWith(
        "Replacement text.",
        "selection-20",
      ),
    );
    expect(mocks.hideContextBar).toHaveBeenCalled();
  });

  it("keeps the result open when the source editor rejects replacement", async () => {
    const user = userEvent.setup();
    mocks.replaceNativeSelection.mockRejectedValueOnce(
      new Error("The source editor ignored the replacement"),
    );
    await mountContextBar();

    emit(
      "native-selection",
      selection("Editable custom control", 20, "clipboardPaste"),
    );
    await user.click(
      screen.getByRole("button", { name: "Run Improve writing" }),
    );
    await waitFor(() => expect(mocks.startNativeRun).toHaveBeenCalledTimes(1));
    emit("codex-event", {
      runId: "run-1",
      message: {
        method: "turn/completed",
        params: {
          turn: {
            status: "completed",
            items: [{ type: "agentMessage", text: "Replacement text." }],
          },
        },
      },
    });

    await screen.findByText("Replacement text.");
    const replace = screen.getByRole("button", { name: /Replace/ });
    await waitFor(() => expect(replace).toBeEnabled());
    await user.click(replace);
    expect(
      await screen.findByText("The source editor ignored the replacement"),
    ).toBeInTheDocument();
    expect(mocks.hideContextBar).not.toHaveBeenCalled();
    expect(mocks.setOverlayPinned).toHaveBeenLastCalledWith(true);
  });
  it("keeps an unverified replacement visible and prevents a second dispatch", async () => {
    mocks.replaceNativeSelection.mockResolvedValueOnce({
      method: "clipboard-paste",
      verified: false,
    });
    const user = userEvent.setup();
    await mountContextBar();
    emit("native-selection", selection("Original", 20, "clipboardPaste"));
    await user.click(
      screen.getByRole("button", { name: "Run Improve writing" }),
    );
    await waitFor(() => expect(mocks.startNativeRun).toHaveBeenCalled());
    emit("codex-event", {
      runId: "run-1",
      message: {
        method: "turn/completed",
        params: {
          turn: {
            status: "completed",
            items: [{ type: "agentMessage", text: "Answer" }],
          },
        },
      },
    });
    await user.click(screen.getByRole("button", { name: /Replace/ }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "could not confirm",
    );
    expect(screen.getByRole("button", { name: /Replace/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Copy response" })).toBeEnabled();
    expect(mocks.hideContextBar).not.toHaveBeenCalled();
  });

  it("buffers early events for the returned run and ignores unrelated runs", async () => {
    let resolve!: (value: { runId: string; prompt: string }) => void;
    mocks.startNativeRun.mockReset().mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const user = userEvent.setup();
    await mountContextBar();
    emit("native-selection", selection("Original", 20));
    await user.click(
      screen.getByRole("button", { name: "Run Improve writing" }),
    );
    await waitFor(() => expect(mocks.startNativeRun).toHaveBeenCalled());
    emit("codex-event", {
      runId: "foreign",
      message: { error: { message: "Unrelated failure" } },
    });
    emit("codex-event", {
      runId: "run-1",
      message: {
        method: "turn/completed",
        params: {
          turn: {
            status: "completed",
            items: [{ type: "agentMessage", text: "Early answer" }],
          },
        },
      },
    });
    await act(async () => resolve({ runId: "run-1", prompt: "" }));
    expect(await screen.findByText("Early answer")).toBeInTheDocument();
    expect(screen.queryByText("Unrelated failure")).not.toBeInTheDocument();
  });

  it("stops a run that finishes starting after the bar was cancelled", async () => {
    let resolve!: (value: { runId: string; prompt: string }) => void;
    mocks.startNativeRun.mockReset().mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const user = userEvent.setup();
    await mountContextBar();
    emit("native-selection", selection("Original", 20));
    await user.click(
      screen.getByRole("button", { name: "Run Improve writing" }),
    );
    await waitFor(() => expect(mocks.startNativeRun).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: /Cancel/ }));
    await act(async () => resolve({ runId: "late-run", prompt: "" }));
    expect(mocks.stopNativeRun).toHaveBeenCalledWith("late-run");
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("does not launch a projectless run after cancelling Ask each time", async () => {
    localStorage.setItem(
      "latch-bar-state-v1",
      JSON.stringify({
        defaultAgentsVersion: DEFAULT_AGENTS_VERSION,
        agents: [{ ...seedAgents[0], workspaceMode: "ask-each-time" }],
        runs: [],
        settings: seedSettings,
      }),
    );
    const user = userEvent.setup();
    await mountContextBar();
    emit("native-selection", selection("Original", 20));
    await user.click(
      screen.getByRole("button", { name: "Run Improve writing" }),
    );
    await waitFor(() => expect(mocks.chooseWorkspaceFolder).toHaveBeenCalled());
    expect(mocks.startNativeRun).not.toHaveBeenCalled();
  });

  it.each(["copy", "replace", "open-studio"] as const)(
    "honors the configured %s output action",
    async (mode) => {
      localStorage.setItem(
        "latch-bar-state-v1",
        JSON.stringify({
          defaultAgentsVersion: DEFAULT_AGENTS_VERSION,
          agents: [
            {
              ...seedAgents[0],
              outputPolicy: {
                ...seedAgents[0].outputPolicy,
                mode,
                allowReplace: true,
              },
            },
          ],
          runs: [],
          settings: seedSettings,
        }),
      );
      const user = userEvent.setup();
      await mountContextBar();
      emit("native-selection", selection("Original", 20));
      await user.click(
        screen.getByRole("button", { name: "Run Improve writing" }),
      );
      await waitFor(() => expect(mocks.startNativeRun).toHaveBeenCalled());
      emit("codex-event", {
        runId: "run-1",
        message: {
          method: "turn/completed",
          params: {
            turn: {
              status: "completed",
              items: [{ type: "agentMessage", text: "Answer" }],
            },
          },
        },
      });
      if (mode === "copy")
        await waitFor(() =>
          expect(mocks.copyNativeText).toHaveBeenCalledWith("Answer"),
        );
      if (mode === "replace")
        await waitFor(() =>
          expect(mocks.replaceNativeSelection).toHaveBeenCalledWith(
            "Answer",
            "selection-20",
          ),
        );
      if (mode === "open-studio")
        await waitFor(() =>
          expect(mocks.openStudio).toHaveBeenCalledWith(true),
        );
    },
  );

  it("never offers placeholder text as a replacement for an empty completion", async () => {
    const user = userEvent.setup();
    await mountContextBar();
    emit("native-selection", selection("Original", 20));
    await user.click(
      screen.getByRole("button", { name: "Run Improve writing" }),
    );
    await waitFor(() => expect(mocks.startNativeRun).toHaveBeenCalled());
    emit("codex-event", {
      runId: "run-1",
      message: {
        method: "turn/completed",
        params: { turn: { status: "completed", items: [] } },
      },
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "without a text response",
    );
    expect(screen.getByRole("button", { name: /Replace/ })).toBeDisabled();
  });
});

vi.mock("../services/persistence", async (original) =>
  (await import("../test/browserPersistence")).browserPersistence(original),
);
