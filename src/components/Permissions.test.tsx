import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { LatchProvider } from "../store/LatchStore";
import { unavailableUpdate } from "../services/updates";

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));

const basePlatform = {
  platform: "macos",
  supported: true,
  accessibilityTrusted: false,
  implementation: "axuielement+guarded-clipboard",
  monitorRunning: true,
  contextBarReady: true,
  selectionTracking: false,
  restartRecommended: false,
};

let platform = { ...basePlatform };
let calls: [string, unknown][] = [];

beforeEach(() => {
  localStorage.clear();
  platform = { ...basePlatform };
  calls = [];
  mockIPC((command, payload) => {
    calls.push([command, payload]);
    if (command === "platform_status") return platform;
    if (command === "request_folder_access") {
      return (payload as { folders: string[] }).folders.map((folder) => ({ folder, path: `/Users/test/${folder}`, granted: true }));
    }
    if (command === "codex_status") return { available: true, version: "0.159.0", codexHome: "/Users/test/.codex", mode: "native", path: "/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex" };
    if (command === "update_state") return unavailableUpdate;
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  clearMocks();
});

const mount = () => render(<LatchProvider><App /></LatchProvider>);

describe("Permission setup", () => {
  it("routes the Context Bar button to setup instead of pausing it while permission is missing", async () => {
    const user = userEvent.setup();
    mount();
    const toggle = await screen.findByRole("button", { name: /Context Bar · Set up/ });
    expect(screen.getByText(/needs Accessibility permission/)).toBeInTheDocument();

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Permissions" })).toHaveClass("active");
    expect(calls.some(([command, payload]) => command === "platform_status" && (payload as { prompt: boolean }).prompt)).toBe(false);
  });

  it("requests folder access and then Accessibility from one setup action", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole("button", { name: /Context Bar · Set up/ }));
    calls = [];

    await user.click(screen.getByRole("button", { name: "Set up permissions" }));

    await waitFor(() => expect(calls.some(([command, payload]) => command === "platform_status" && (payload as { prompt: boolean }).prompt)).toBe(true));
    const folderCall = calls.findIndex(([command]) => command === "request_folder_access");
    const accessibilityCall = calls.findIndex(([command, payload]) => command === "platform_status" && (payload as { prompt: boolean }).prompt);
    expect(calls[folderCall][1]).toEqual({ folders: ["documents"] });
    expect(folderCall).toBeLessThan(accessibilityCall);
    expect(JSON.parse(localStorage.getItem("latch-folder-access")!).documents.granted).toBe(true);
  });

  it("shows the discovered Codex executable and an active tracker once Accessibility is allowed", async () => {
    platform = { ...basePlatform, accessibilityTrusted: true, selectionTracking: true };
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Permissions" }));

    const tracking = (await screen.findByText("Selection tracking")).closest(".setting-row") as HTMLElement;
    expect(within(tracking).getByText("Active")).toBeInTheDocument();
    expect(await screen.findByText(/Codex\.app\/Contents\/Resources\/codex-cli\/bin\/codex/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Context Bar$/ })).toBeInTheDocument();
  });

  it("offers a relaunch when tracking cannot start after Accessibility is allowed", async () => {
    platform = { ...basePlatform, accessibilityTrusted: true, restartRecommended: true };
    const user = userEvent.setup();
    mount();

    await user.click(await screen.findByRole("button", { name: "Relaunch" }));

    expect(calls.some(([command]) => command === "relaunch_app")).toBe(true);
  });
});
