import { FileCode2, ShieldAlert, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import {
  getRuntimeStatus,
  openPrivacySettings,
  type ProtectedFolder,
  type RuntimeStatus,
} from "../services/runtime";
import { useLatch } from "../store/LatchStore";
import { usePermissions } from "../store/PermissionStore";

const folderCopy: Record<ProtectedFolder, [string, string]> = {
  documents: [
    "Documents folder",
    "Agents without a workspace run in Documents → Codex → Latch Bar.",
  ],
  desktop: ["Desktop folder", "One of your workspaces is on the Desktop."],
  downloads: ["Downloads folder", "One of your workspaces is in Downloads."],
};

function State({ ready, children }: { ready: boolean; children: string }) {
  return (
    <small className={ready ? "permission-state ready" : "permission-state"}>
      {children}
    </small>
  );
}

export function PermissionNotice() {
  const { activeNav } = useLatch();
  const { needsSetup, platform, view, relaunch } = usePermissions();
  if (!needsSetup || activeNav === "settings") return null;
  const restart = platform?.accessibilityTrusted && platform.restartRecommended;
  return (
    <div className="update-notice permission-notice" role="status">
      <span>
        {restart
          ? "Relaunch Latch Bar to finish turning on the Context Bar."
          : "The Context Bar needs Accessibility permission before it can see your selections."}
      </span>
      {restart ? (
        <button onClick={() => void relaunch()}>Relaunch</button>
      ) : (
        <button onClick={view}>Set up permissions</button>
      )}
    </div>
  );
}

export function PermissionsPanel({ onOpenCodex }: { onOpenCodex: () => void }) {
  const {
    codexEnvironment,
    environmentStatus,
    environmentError,
    refreshCodexEnvironment,
    settings,
    notify,
  } = useLatch();
  const {
    platform,
    folders,
    folderAccess,
    busy,
    setUp,
    requestAccessibility,
    requestFolders,
    repairAccessibility,
    relaunch,
    refresh,
  } = usePermissions();
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [runtimeError, setRuntimeError] = useState("");
  const [checkingRuntime, setCheckingRuntime] = useState(true);
  useEffect(() => {
    void getRuntimeStatus()
      .then(setRuntime)
      .catch((error) => setRuntimeError(String(error)))
      .finally(() => setCheckingRuntime(false));
  }, []);

  if (platform && !platform.supported) {
    return (
      <div className="settings-panel">
        <div className="runtime-card">
          <span className="runtime-large-icon">
            <ShieldCheck size={23} />
          </span>
          <div>
            <span className="eyebrow">PERMISSIONS</span>
            <h3>Open the desktop app</h3>
            <p>Permissions apply to the installed Latch Bar app on macOS.</p>
          </div>
        </div>
      </div>
    );
  }

  const accessibility = Boolean(platform?.accessibilityTrusted);
  const restart = accessibility && Boolean(platform?.restartRecommended);
  const tracking = accessibility && Boolean(platform?.selectionTracking);
  const missingFolders = folders.filter(
    (folder) => !folderAccess[folder]?.granted,
  );
  const codexInstalled = Boolean(runtime?.available);
  const accountError = codexEnvironment?.errors.find((error) =>
    error.includes("account/read"),
  );
  const connectionError =
    runtimeError ||
    (environmentStatus === "error"
      ? environmentError || "Could not connect to Codex."
      : accountError);
  const codexChecking =
    checkingRuntime ||
    environmentStatus === "loading" ||
    environmentStatus === "idle";
  const codexConnected =
    codexInstalled &&
    !connectionError &&
    environmentStatus === "ready" &&
    Boolean(codexEnvironment);
  const codexReady =
    codexConnected &&
    Boolean(
      codexEnvironment?.account.signedIn ||
      codexEnvironment?.account.requiresOpenaiAuth === false,
    );
  const codexLabel = codexChecking
    ? "Checking"
    : runtimeError
      ? "Check failed"
      : !codexInstalled
        ? "Not found"
        : !codexConnected
          ? "Connection failed"
          : codexReady
            ? codexEnvironment?.account.signedIn
              ? "Signed in"
              : "Ready"
            : "Sign-in required";
  const permissionPending = !accessibility || missingFolders.length > 0;
  const pending =
    missingFolders.length +
    [
      !accessibility || restart || (settings.contextBarEnabled && !tracking),
      !codexReady,
    ].filter(Boolean).length;

  const openSettings = (pane: "accessibility" | "files") =>
    void openPrivacySettings(pane).catch(() =>
      notify("Could not open System Settings"),
    );
  const checkCodex = async () => {
    setCheckingRuntime(true);
    setRuntimeError("");
    try {
      const [status] = await Promise.all([
        getRuntimeStatus(true),
        refreshCodexEnvironment(undefined, undefined, true),
      ]);
      setRuntime(status);
    } catch (error) {
      setRuntimeError(String(error));
    } finally {
      setCheckingRuntime(false);
    }
  };
  const checkAll = () => Promise.all([refresh(), checkCodex()]);

  return (
    <div className="settings-panel">
      <div className="runtime-card">
        <span className="runtime-large-icon">
          {pending ? <ShieldAlert size={23} /> : <ShieldCheck size={23} />}
        </span>
        <div>
          <span className="eyebrow">PERMISSIONS</span>
          <h3>
            {!platform || codexChecking
              ? "Checking setup"
              : pending
                ? `${pending} ${pending === 1 ? "item needs" : "items need"} your attention`
                : "Latch has everything it needs"}
          </h3>
          <p>
            {restart
              ? "Selection tracking could not start in this session. Finish active agents and save any edits before relaunching."
              : "Set up requests permissions for your current configuration. Latch checks access when you return from System Settings. New workspace locations may need additional access."}
          </p>
        </div>
        {restart ? (
          <button className="primary-button" onClick={() => void relaunch()}>
            Relaunch Latch Bar
          </button>
        ) : (
          <button
            className={
              permissionPending ? "primary-button" : "secondary-button"
            }
            disabled={
              busy || !platform || (!permissionPending && codexChecking)
            }
            onClick={() => void (permissionPending ? setUp() : checkAll())}
          >
            {busy
              ? "Waiting for macOS…"
              : permissionPending
                ? "Set up permissions"
                : "Check again"}
          </button>
        )}
      </div>

      <div className="setting-group">
        <h3>macOS privacy</h3>
        <div className="setting-row permission-row">
          <div>
            <strong>Accessibility</strong>
            <p>
              Required. Lets Latch read the text you select and put results back
              into the app.
            </p>
          </div>
          <span>
            <State ready={accessibility}>
              {accessibility ? "Allowed" : "Not allowed"}
            </State>
            {!accessibility && (
              <>
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => void requestAccessibility()}
                >
                  Allow
                </button>
                <button
                  className="secondary-button"
                  onClick={() => openSettings("accessibility")}
                >
                  Open System Settings
                </button>
              </>
            )}
          </span>
        </div>
        <div className="setting-row permission-row">
          <div>
            <strong>Selection tracking</strong>
            <p>
              Finds selections in browsers and Electron apps. Starts on its own
              once Accessibility is allowed.
            </p>
          </div>
          <span>
            <State ready={tracking}>
              {!accessibility
                ? "Waiting for Accessibility"
                : tracking
                  ? "Active"
                  : restart
                    ? "Needs relaunch"
                    : settings.contextBarEnabled
                      ? "Starting"
                      : "Paused"}
            </State>
            {restart && (
              <button
                className="secondary-button"
                onClick={() => void relaunch()}
              >
                Relaunch
              </button>
            )}
          </span>
        </div>
        {folders.map((folder) => {
          const access = folderAccess[folder];
          return (
            <div className="setting-row permission-row" key={folder}>
              <div>
                <strong>{folderCopy[folder][0]}</strong>
                <p>{folderCopy[folder][1]}</p>
              </div>
              <span>
                <State ready={Boolean(access?.granted)}>
                  {!access
                    ? "Not requested"
                    : access.granted
                      ? "Allowed"
                      : "Not allowed"}
                </State>
                {!access && (
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => void requestFolders()}
                  >
                    Allow
                  </button>
                )}
                {access && !access.granted && (
                  <button
                    className="secondary-button"
                    onClick={() => openSettings("files")}
                  >
                    Open System Settings
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>

      {!accessibility && (
        <div className="setting-group">
          <h3>Accessibility switch already on?</h3>
          <div className="setting-row">
            <div>
              <strong>Repair stale Accessibility entry</strong>
              <p>
                Removes an old copy of Latch Bar from macOS and requests access
                for this installed copy.
              </p>
            </div>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => void repairAccessibility()}
            >
              Repair permission
            </button>
          </div>
        </div>
      )}

      <div className="setting-group">
        <h3>Agent runtime</h3>
        <div className="setting-row permission-row">
          <div>
            <strong>Codex</strong>
            <p>
              {codexInstalled
                ? `Version ${runtime!.version}${runtime!.path ? ` · ${runtime!.path}` : ""}`
                : runtime
                  ? "Not found. Install the Codex app or the Codex CLI and sign in."
                  : "Looking for the Codex app or CLI."}
            </p>
            {!codexChecking && connectionError && (
              <p role="alert">{connectionError}</p>
            )}
            {!codexChecking && codexConnected && !codexReady && (
              <p>Sign in through Codex, then choose Check again.</p>
            )}
          </div>
          <span>
            <State ready={!codexChecking && codexReady}>{codexLabel}</State>
            <button
              className="secondary-button"
              disabled={codexChecking}
              onClick={() => void checkCodex()}
            >
              Check again
            </button>
            <button className="secondary-button" onClick={onOpenCodex}>
              <FileCode2 size={13} />
              Details
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
