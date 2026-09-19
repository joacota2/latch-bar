import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspacesPage } from "./WorkspacesPage";
import { LatchProvider } from "../store/LatchStore";
const mocks = vi.hoisted(() => ({ choose: vi.fn(), reveal: vi.fn(), copy: vi.fn() }));
vi.mock("../services/runtime", () => ({ isTauri: () => false, scanCodexEnvironment: vi.fn(), chooseWorkspaceFolder: mocks.choose, copyNativeText: mocks.copy }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: mocks.reveal }));
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });
afterEach(cleanup);
describe("workspaces", () => {
  it("opens the folder picker, persists the folder, and exposes working menu actions", async () => {
    const user = userEvent.setup();
    mocks.choose.mockResolvedValue("/projects/demo");
    render(<LatchProvider><WorkspacesPage /></LatchProvider>);
    await user.click(screen.getByRole("button", { name: "Add workspace" }));
    expect(await screen.findByText("/projects/demo")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Workspace menu for demo" }));
    await user.click(screen.getByRole("button", { name: "Copy path" }));
    expect(await navigator.clipboard.readText()).toBe("/projects/demo");
    await user.click(screen.getByRole("button", { name: "Workspace menu for demo" }));
    await user.click(screen.getByRole("button", { name: "Create agent here" }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("latch-bar-state-v1")!).agents.at(-1)).toMatchObject({ workspaceMode: "fixed", fixedWorkspacePath: "/projects/demo" }));
  });
  it("treats picker cancellation as a no-op", async () => {
    mocks.choose.mockResolvedValue(null);
    render(<LatchProvider><WorkspacesPage /></LatchProvider>);
    await userEvent.setup().click(screen.getByRole("button", { name: "Add workspace" }));
    expect(localStorage.getItem("latch-bar-state-v1")).toBeNull();
  });
});
