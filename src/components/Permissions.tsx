import { FileCode2, ShieldAlert, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { getRuntimeStatus, openPrivacySettings, type ProtectedFolder, type RuntimeStatus } from "../services/runtime";
import { useLatch } from "../store/LatchStore";
import { usePermissions } from "../store/PermissionStore";

const folderCopy: Record<ProtectedFolder, [string, string]> = {
  documents: ["Documents folder", "Agents without a workspace run in Documents → Codex → Latch Bar."],
  desktop: ["Desktop folder", "One of your workspaces is on the Desktop."],
  downloads: ["Downloads folder", "One of your workspaces is in Downloads."],
};

function State({ ready, children }: { ready: boolean; children: string }) {
  return <small className={ready ? "permission-state ready" : "permission-state"}>{children}</small>;
}

export function PermissionNotice() {
  const { activeNav } = useLatch();
  const { needsSetup, platform, view, relaunch } = usePermissions();
  if (!needsSetup || activeNav === "settings") return null;
  const restart = platform?.accessibilityTrusted && platform.restartRecommended;
  return <div className="update-notice permission-notice" role="status">
    <span>{restart ? "Relaunch Latch Bar to finish turning on the Context Bar." : "The Context Bar needs Accessibility permission before it can see your selections."}</span>
    {restart ? <button onClick={() => void relaunch()}>Relaunch</button> : <button onClick={view}>Set up permissions</button>}
  </div>;
}

export function PermissionsPanel({ onOpenCodex }: { onOpenCodex: () => void }) {
  const { codexEnvironment, environmentStatus, refreshCodexEnvironment, notify } = useLatch();
  const { platform, folders, folderAccess, busy, setUp, requestAccessibility, requestFolders, repairAccessibility, relaunch, refresh } = usePermissions();
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  useEffect(() => { void getRuntimeStatus().then(setRuntime).catch(() => undefined); }, []);

  if (platform && !platform.supported) {
    return <div className="settings-panel"><div className="runtime-card"><span className="runtime-large-icon"><ShieldCheck size={23} /></span><div><span className="eyebrow">PERMISSIONS</span><h3>Open the desktop app</h3><p>Permissions apply to the installed Latch Bar app on macOS.</p></div></div></div>;
  }

  const accessibility = Boolean(platform?.accessibilityTrusted);
  const restart = accessibility && Boolean(platform?.restartRecommended);
  const tracking = accessibility && Boolean(platform?.selectionTracking);
  const missingFolders = folders.filter((folder) => !folderAccess[folder]?.granted);
  const codexReady = Boolean(runtime?.available);
  const pending = [!accessibility || restart, missingFolders.length > 0, !codexReady].filter(Boolean).length;

  const openSettings = (pane: "accessibility" | "files") => void openPrivacySettings(pane).catch(() => notify("Could not open System Settings"));
  const checkCodex = async () => {
    const [status] = await Promise.all([getRuntimeStatus(), refreshCodexEnvironment()]);
    setRuntime(status);
  };

  return <div className="settings-panel">
    <div className="runtime-card">
      <span className="runtime-large-icon">{pending ? <ShieldAlert size={23} /> : <ShieldCheck size={23} />}</span>
      <div>
        <span className="eyebrow">PERMISSIONS</span>
        <h3>{!platform ? "Checking permissions" : pending ? `${pending} ${pending === 1 ? "item needs" : "items need"} your attention` : "Latch has everything it needs"}</h3>
        <p>{restart ? "Selection tracking could not start in this session. Relaunch Latch Bar to finish." : "Set up asks macOS for every permission at once, so nothing interrupts you later. Latch detects each change automatically."}</p>
      </div>
      {restart
        ? <button className="primary-button" onClick={() => void relaunch()}>Relaunch Latch Bar</button>
        : <button className={pending ? "primary-button" : "secondary-button"} disabled={busy || !platform} onClick={() => void (pending ? setUp() : refresh())}>{busy ? "Waiting for macOS…" : pending ? "Set up permissions" : "Check again"}</button>}
    </div>

    <div className="setting-group"><h3>macOS privacy</h3>
      <div className="setting-row permission-row">
        <div><strong>Accessibility</strong><p>Required. Lets Latch read the text you select and put results back into the app.</p></div>
        <span><State ready={accessibility}>{accessibility ? "Allowed" : "Not allowed"}</State>{!accessibility && <><button className="secondary-button" disabled={busy} onClick={() => void requestAccessibility()}>Allow</button><button className="secondary-button" onClick={() => openSettings("accessibility")}>Open System Settings</button></>}</span>
      </div>
      <div className="setting-row permission-row">
        <div><strong>Selection tracking</strong><p>Finds selections in browsers and Electron apps. Starts on its own once Accessibility is allowed.</p></div>
        <span><State ready={tracking}>{!accessibility ? "Waiting for Accessibility" : tracking ? "Active" : restart ? "Needs relaunch" : "Starting"}</State>{restart && <button className="secondary-button" onClick={() => void relaunch()}>Relaunch</button>}</span>
      </div>
      {folders.map((folder) => {
        const access = folderAccess[folder];
        return <div className="setting-row permission-row" key={folder}>
          <div><strong>{folderCopy[folder][0]}</strong><p>{folderCopy[folder][1]}</p></div>
          <span><State ready={Boolean(access?.granted)}>{!access ? "Not requested" : access.granted ? "Allowed" : "Not allowed"}</State>{!access && <button className="secondary-button" disabled={busy} onClick={() => void requestFolders()}>Allow</button>}{access && !access.granted && <button className="secondary-button" onClick={() => openSettings("files")}>Open System Settings</button>}</span>
        </div>;
      })}
    </div>

    {!accessibility && <div className="setting-group"><h3>Accessibility switch already on?</h3><div className="setting-row"><div><strong>Repair stale Accessibility entry</strong><p>Removes an old copy of Latch Bar from macOS and requests access for this installed copy.</p></div><button className="secondary-button" disabled={busy} onClick={() => void repairAccessibility()}>Repair permission</button></div></div>}

    <div className="setting-group"><h3>Agent runtime</h3>
      <div className="setting-row permission-row">
        <div><strong>Codex</strong><p>{codexReady ? `Version ${runtime!.version}${runtime!.path ? ` · ${runtime!.path}` : ""}` : runtime ? "Not found. Install the Codex app or the Codex CLI and sign in." : "Looking for the Codex app or CLI."}</p></div>
        <span><State ready={codexReady && Boolean(codexEnvironment?.account.signedIn || codexEnvironment?.account.requiresOpenaiAuth === false)}>{!runtime ? "Checking" : !codexReady ? "Not found" : codexEnvironment?.account.signedIn ? "Signed in" : codexEnvironment && !codexEnvironment.account.requiresOpenaiAuth ? "Ready" : environmentStatus === "loading" ? "Checking" : "Not signed in"}</State><button className="secondary-button" disabled={environmentStatus === "loading"} onClick={() => void checkCodex()}>Check again</button><button className="secondary-button" onClick={onOpenCodex}><FileCode2 size={13} />Details</button></span>
      </div>
    </div>
  </div>;
}
