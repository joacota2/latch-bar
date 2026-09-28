import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LatchProvider, useLatch } from "../store/LatchStore";
import { UpdateProvider } from "../store/UpdateStore";
import { UpdateNotice, UpdateOverlay, UpdatesPanel } from "./Updates";
import { unavailableUpdate, type UpdateState } from "../services/updates";

const mocks = vi.hoisted(() => ({
  get: vi.fn(), check: vi.fn(), install: vi.fn(), editor: vi.fn(),
  callback: undefined as ((state: UpdateState) => void) | undefined,
}));
vi.mock("../services/updates", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/updates")>(),
  getUpdateState: mocks.get, checkForUpdates: mocks.check, installUpdate: mocks.install, setUpdateEditorState: mocks.editor,
  onUpdateState: vi.fn(async (callback: (state: UpdateState) => void) => { mocks.callback = callback; return () => { mocks.callback = undefined; }; }),
}));

const available: UpdateState = {
  ...unavailableUpdate, enabled: true, revision: 1, currentVersion: "0.2.1", phase: "available",
  availableVersion: "0.3.0", notes: "A better Latch", lastCheckedAt: 1000,
};
function EditorButton() {
  const { setSelectedAgentId } = useLatch();
  return <button onClick={() => setSelectedAgentId("editing")}>Edit profile</button>;
}
function mount() {
  return render(<LatchProvider><UpdateProvider><EditorButton /><UpdateNotice /><UpdatesPanel /><UpdateOverlay /></UpdateProvider></LatchProvider>);
}

describe("Updates", () => {
  beforeEach(() => {
    localStorage.clear(); vi.clearAllMocks(); mocks.get.mockResolvedValue(available);
    mocks.editor.mockResolvedValue(undefined); mocks.install.mockResolvedValue(undefined);
    mocks.check.mockResolvedValue({ ...available, revision: 2 });
  });
  afterEach(cleanup);

  it("does not download on discovery and keeps a postponed update in Settings", async () => {
    const user = userEvent.setup(); mount();
    expect(await screen.findByText("Version 0.3.0 is available")).toBeInTheDocument();
    expect(mocks.install).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Later" }));
    expect(screen.queryByRole("button", { name: "View update" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update and restart" })).toBeEnabled();
    act(() => mocks.callback?.({ ...available, revision: 2 }));
    expect(screen.queryByRole("button", { name: "View update" })).not.toBeInTheDocument();
    act(() => mocks.callback?.({ ...available, revision: 3, availableVersion: "0.4.0" }));
    expect(screen.getByRole("button", { name: "View update" })).toBeInTheDocument();
  });

  it("checks manually and only reports up to date after a successful check", async () => {
    const user = userEvent.setup(); mocks.get.mockResolvedValue({ ...available, phase: "idle", availableVersion: null });
    mocks.check.mockResolvedValue({ ...available, revision: 2, phase: "upToDate", availableVersion: null });
    mount(); await waitFor(() => expect(screen.getByRole("button", { name: "Check for updates" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("You’re up to date.")).toBeInTheDocument();
    act(() => mocks.callback?.({ ...available, revision: 3, phase: "error", availableVersion: null, error: "Could not check for updates: offline" }));
    expect(screen.queryByText("You’re up to date.")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("offline");
  });

  it("installs only on request, deduplicates clicks, and supports unknown download sizes", async () => {
    const user = userEvent.setup(); let finish!: () => void;
    mocks.install.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    mount(); await screen.findByText("Version 0.3.0 is available");
    await user.dblClick(screen.getByRole("button", { name: "Update and restart" }));
    expect(mocks.install).toHaveBeenCalledTimes(1);
    act(() => mocks.callback?.({ ...available, revision: 2, phase: "downloading", downloadedBytes: 1024 }));
    expect(screen.getByRole("dialog", { name: "Updating Latch Bar" })).toBeInTheDocument();
    for (const progress of screen.getAllByRole("progressbar")) expect(progress).not.toHaveAttribute("value");
    act(() => mocks.callback?.({ ...available, revision: 3, phase: "downloading", downloadedBytes: 50, totalBytes: 100 }));
    for (const progress of screen.getAllByRole("progressbar")) expect(progress).toHaveAttribute("value", "50");
    await act(async () => finish());
  });

  it("shows installation errors and allows retry", async () => {
    const user = userEvent.setup(); mocks.install.mockRejectedValueOnce("Finish or cancel active agents before updating.");
    mount(); await screen.findByText("Version 0.3.0 is available");
    await user.click(screen.getByRole("button", { name: "Update and restart" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("active agents");
    await user.click(screen.getByRole("button", { name: "Update and restart" }));
    expect(mocks.install).toHaveBeenCalledTimes(2);
  });

  it("protects unsaved profile edits", async () => {
    const user = userEvent.setup(); mount(); await screen.findByText("Version 0.3.0 is available");
    await user.click(screen.getByRole("button", { name: "Edit profile" }));
    expect(screen.getByRole("button", { name: "Update and restart" })).toBeDisabled();
    expect(mocks.editor).toHaveBeenLastCalledWith(true);
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("ignores stale snapshots and events", async () => {
    let resolveSnapshot!: (state: UpdateState) => void;
    mocks.get.mockImplementation(() => new Promise<UpdateState>((resolve) => { resolveSnapshot = resolve; }));
    mount(); await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    act(() => mocks.callback?.({ ...available, revision: 5, phase: "installing" }));
    await act(async () => resolveSnapshot(available));
    expect(screen.getByRole("dialog", { name: "Updating Latch Bar" })).toBeInTheDocument();
  });

  it("disables controls outside release builds", async () => {
    mocks.get.mockResolvedValue(unavailableUpdate); mount();
    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Update and restart" })).not.toBeInTheDocument();
    expect(mocks.check).not.toHaveBeenCalled();
  });
});
