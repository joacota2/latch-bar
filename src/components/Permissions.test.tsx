import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { LatchProvider, useLatch } from "../store/LatchStore";
import { unavailableUpdate } from "../services/updates";
import { seedAgents } from "../data/seed";
import type { Snapshot } from "../services/persistence";

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
let folderGranted = true;
let connectionError = "";
let relaunchError = "";
let account = { signedIn: true, requiresOpenaiAuth: true };
let discoveryErrors: string[] = [];
let nativeState: Snapshot | null = null;

beforeEach(() => {
  localStorage.clear();
  platform = { ...basePlatform };
  calls = [];
  folderGranted = true;
  connectionError = "";
  relaunchError = "";
  account = { signedIn: true, requiresOpenaiAuth: true };
  discoveryErrors = [];
  nativeState = null;
  mockIPC((command, payload) => {
    calls.push([command, payload]);
    if (command === "read_latch_state")
      return (nativeState ??= {
        revision: 0,
        epoch: "test",
        state: (payload as { initial: Snapshot["state"] }).initial,
      });
    if (command === "scan_codex_environment") {
      if (connectionError) throw new Error(connectionError);
      return {
        account,
        workspaces: [],
        models: [],
        mcpServers: [],
        skills: [],
        errors: discoveryErrors,
      };
    }
    if (command === "relaunch_app" && relaunchError)
      throw new Error(relaunchError);
    if (command === "platform_status") return platform;
    if (command === "request_folder_access") {
      return (payload as { folders: string[] }).folders.map((folder) => ({
        folder,
        path: `/Users/test/${folder}`,
        granted: folderGranted,
      }));
    }
    if (command === "codex_status")
      return {
        available: true,
        version: "0.159.0",
        codexHome: "/Users/test/.codex",
        mode: "native",
        path: "/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex",
      };
    if (command === "update_state") return unavailableUpdate;
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  clearMocks();
});

function EditorButton() {
  const { setSelectedAgentId } = useLatch();
  return (
    <button onClick={() => setSelectedAgentId("editing")}>Edit profile</button>
  );
}
const mount = () =>
  render(
    <LatchProvider>
      <EditorButton />
      <App />
    </LatchProvider>,
  );
const folderRow = () =>
  screen.getByText("Documents folder").closest(".setting-row") as HTMLElement;
const summary = () =>
  screen
    .getByRole("heading", {
      name: /Latch has everything|items? needs? your attention|Checking setup/,
    })
    .closest(".runtime-card") as HTMLElement;
async function openPermissions() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Settings" }));
  await user.click(screen.getByRole("button", { name: "Permissions" }));
  return user;
}
function cacheFolder(granted: boolean) {
  localStorage.setItem(
    "latch-folder-access",
    JSON.stringify({
      documents: {
        folder: "documents",
        path: "/Users/test/Documents",
        granted,
      },
    }),
  );
}

describe("Permission setup", () => {
  it("rechecks folder grants and revocations when returning from System Settings", async () => {
    folderGranted = false;
    cacheFolder(false);
    mount();
    await openPermissions();
    expect(within(folderRow()).getByText("Not allowed")).toBeInTheDocument();
    folderGranted = true;
    fireEvent.focus(window);
    await waitFor(() =>
      expect(within(folderRow()).getByText("Allowed")).toBeInTheDocument(),
    );
    folderGranted = false;
    fireEvent.focus(window);
    await waitFor(() =>
      expect(within(folderRow()).getByText("Not allowed")).toBeInTheDocument(),
    );
  });

  it("does not request new folders on launch or focus", async () => {
    mount();
    await openPermissions();
    fireEvent.focus(window);
    await waitFor(() =>
      expect(calls.some(([command]) => command === "platform_status")).toBe(
        true,
      ),
    );
    expect(calls.some(([command]) => command === "request_folder_access")).toBe(
      false,
    );
  });

  it.each([
    ["/Users/test/Desktop/project", "desktop"],
    [" ~/Downloads/project ", "downloads"],
  ])(
    "includes fixed agent path %s without a saved or discovered workspace",
    async (path, folder) => {
      localStorage.setItem(
        "latch-bar-state-v1",
        JSON.stringify({
          agents: [
            {
              ...seedAgents[0],
              workspaceMode: "fixed",
              fixedWorkspacePath: path,
            },
          ],
        }),
      );
      mount();
      const user = await openPermissions();
      await user.click(
        screen.getByRole("button", { name: "Set up permissions" }),
      );
      await waitFor(() =>
        expect(calls).toContainEqual([
          "request_folder_access",
          { folders: ["documents", folder] },
        ]),
      );
    },
  );

  it("reports connection failure instead of signed out or ready, and the main check retries everything", async () => {
    platform = {
      ...basePlatform,
      accessibilityTrusted: true,
      selectionTracking: true,
    };
    cacheFolder(true);
    connectionError = "Codex app-server stopped while handling initialize";
    mount();
    const user = await openPermissions();
    expect(await screen.findByText("Connection failed")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(connectionError);
    expect(screen.queryByText("Sign-in required")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Latch has everything it needs"),
    ).not.toBeInTheDocument();
    connectionError = "";
    calls = [];
    await user.click(
      within(summary()).getByRole("button", { name: "Check again" }),
    );
    expect(
      await screen.findByText("Latch has everything it needs"),
    ).toBeInTheDocument();
    expect(calls.some(([command]) => command === "request_folder_access")).toBe(
      true,
    );
    expect(
      calls.some(([command]) => command === "scan_codex_environment"),
    ).toBe(true);
    expect(calls.some(([command]) => command === "codex_status")).toBe(true);
  });

  it("requires sign-in only after a successful account response and recovers after sign-in", async () => {
    platform = {
      ...basePlatform,
      accessibilityTrusted: true,
      selectionTracking: true,
    };
    cacheFolder(true);
    account = { signedIn: false, requiresOpenaiAuth: true };
    mount();
    const user = await openPermissions();
    expect(await screen.findByText("Sign-in required")).toBeInTheDocument();
    expect(
      screen.queryByText("Latch has everything it needs"),
    ).not.toBeInTheDocument();
    account = { signedIn: true, requiresOpenaiAuth: true };
    await user.click(
      within(summary()).getByRole("button", { name: "Check again" }),
    );
    expect(
      await screen.findByText("Latch has everything it needs"),
    ).toBeInTheDocument();
  });

  it("does not mistake a failed account query for a provider that needs no authentication", async () => {
    platform = {
      ...basePlatform,
      accessibilityTrusted: true,
      selectionTracking: true,
    };
    cacheFolder(true);
    account = { signedIn: false, requiresOpenaiAuth: false };
    discoveryErrors = ["account/read: connection closed"];
    mount();
    const user = await openPermissions();
    expect(await screen.findByText("Connection failed")).toBeInTheDocument();
    expect(
      screen.queryByText("Latch has everything it needs"),
    ).not.toBeInTheDocument();
    discoveryErrors = [];
    await user.click(
      within(summary()).getByRole("button", { name: "Check again" }),
    );
    expect(
      await screen.findByText("Ready", { exact: true }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Latch has everything it needs"),
    ).toBeInTheDocument();
  });

  it("keeps a failed recheck from displaying a previously signed-in connection as ready", async () => {
    platform = {
      ...basePlatform,
      accessibilityTrusted: true,
      selectionTracking: true,
    };
    cacheFolder(true);
    mount();
    const user = await openPermissions();
    await screen.findByText("Latch has everything it needs");
    connectionError = "Codex app-server connection failed";
    await user.click(
      within(summary()).getByRole("button", { name: "Check again" }),
    );
    expect(await screen.findByText("Connection failed")).toBeInTheDocument();
    expect(screen.queryByText("Signed in")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Latch has everything it needs"),
    ).not.toBeInTheDocument();
  });

  it("preserves the native relaunch refusal instead of suggesting an unsafe manual quit", async () => {
    platform = {
      ...basePlatform,
      accessibilityTrusted: true,
      restartRecommended: true,
    };
    relaunchError =
      "Finish or cancel active agents, including pending approvals, before relaunching.";
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Relaunch" }));
    expect(
      await screen.findByText(new RegExp(relaunchError)),
    ).toBeInTheDocument();
  });

  it("refuses relaunch while an editor is open even before the native editor state catches up", async () => {
    platform = {
      ...basePlatform,
      accessibilityTrusted: true,
      restartRecommended: true,
    };
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Edit profile" }));
    await user.click(await screen.findByRole("button", { name: "Relaunch" }));
    expect(
      await screen.findByText(
        "Save your changes and close the agent editor before relaunching.",
      ),
    ).toBeInTheDocument();
    expect(calls.some(([command]) => command === "relaunch_app")).toBe(false);
  });

  it("routes the Context Bar button to setup instead of pausing it while permission is missing", async () => {
    const user = userEvent.setup();
    mount();
    const toggle = await screen.findByRole("button", {
      name: /Context Bar · Set up/,
    });
    expect(
      screen.getByText(/needs Accessibility permission/),
    ).toBeInTheDocument();

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Permissions" })).toHaveClass(
      "active",
    );
    expect(
      calls.some(
        ([command, payload]) =>
          command === "platform_status" &&
          (payload as { prompt: boolean }).prompt,
      ),
    ).toBe(false);
  });

  it("requests folder access and then Accessibility from one setup action", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(
      await screen.findByRole("button", { name: /Context Bar · Set up/ }),
    );
    calls = [];

    await user.click(
      screen.getByRole("button", { name: "Set up permissions" }),
    );

    await waitFor(() =>
      expect(
        calls.some(
          ([command, payload]) =>
            command === "platform_status" &&
            (payload as { prompt: boolean }).prompt,
        ),
      ).toBe(true),
    );
    const folderCall = calls.findIndex(
      ([command]) => command === "request_folder_access",
    );
    const accessibilityCall = calls.findIndex(
      ([command, payload]) =>
        command === "platform_status" &&
        (payload as { prompt: boolean }).prompt,
    );
    expect(calls[folderCall][1]).toEqual({ folders: ["documents"] });
    expect(folderCall).toBeLessThan(accessibilityCall);
    expect(
      JSON.parse(localStorage.getItem("latch-folder-access")!).documents
        .granted,
    ).toBe(true);
  });

  it("shows the discovered Codex executable and an active tracker once Accessibility is allowed", async () => {
    platform = {
      ...basePlatform,
      accessibilityTrusted: true,
      selectionTracking: true,
    };
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Permissions" }));

    const tracking = (await screen.findByText("Selection tracking")).closest(
      ".setting-row",
    ) as HTMLElement;
    expect(within(tracking).getByText("Active")).toBeInTheDocument();
    expect(
      await screen.findByText(
        /Codex\.app\/Contents\/Resources\/codex-cli\/bin\/codex/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Context Bar$/ }),
    ).toBeInTheDocument();
  });

  it("offers a relaunch when tracking cannot start after Accessibility is allowed", async () => {
    platform = {
      ...basePlatform,
      accessibilityTrusted: true,
      restartRecommended: true,
    };
    const user = userEvent.setup();
    mount();

    await user.click(await screen.findByRole("button", { name: "Relaunch" }));

    expect(calls.some(([command]) => command === "relaunch_app")).toBe(true);
  });
});
