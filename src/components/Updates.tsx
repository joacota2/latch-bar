import { useUpdates } from "../store/UpdateStore";
import { useLatch } from "../store/LatchStore";
import { installingUpdate, type UpdateState } from "../services/updates";

export function UpdateProgress({ state }: { state: UpdateState }) {
  const total = state.totalBytes;
  const percent = total ? Math.min(100, Math.round(state.downloadedBytes / total * 100)) : undefined;
  const text = state.phase === "restarting" ? "Restarting Latch Bar…" : state.phase === "installing" ? "Installing update…" : "Downloading update…";
  return <div className="update-progress" role="status">
    <p>{text} {state.phase === "downloading" && (percent === undefined ? `${(state.downloadedBytes / 1024 / 1024).toFixed(1)} MB` : `${percent}%`)}</p>
    <progress aria-label="Update progress" max={100} value={state.phase === "downloading" ? percent : undefined} />
  </div>;
}

export function UpdatesPanel() {
  const { state, busy, error, check, install } = useUpdates();
  const { selectedAgentId } = useLatch();
  return <section className="setting-group updates-panel" aria-label="Updates" id="updates">
    <h3>Updates</h3>
    <div className="setting-row">
      <div><strong>Latch Bar{state.currentVersion && ` ${state.currentVersion}`}</strong>
        <p>{!state.enabled ? "Updates are available in the installed macOS release app." : "Checks automatically. Downloads and installs only when you choose."}</p>
        {(state.phase === "upToDate" || state.lastCheckedAt) && <div className="update-status">
          {state.phase === "upToDate" && <span role="status">You’re up to date.</span>}
          {state.lastCheckedAt && <span className="update-last-checked">Last checked: {new Date(state.lastCheckedAt).toLocaleString()}</span>}
        </div>}
      </div>
      <button className="secondary-button" disabled={!state.enabled || busy} onClick={() => void check()}>{state.phase === "checking" ? "Checking…" : "Check for updates"}</button>
    </div>
    {(state.availableVersion || installingUpdate(state.phase) || error || state.error) && <div className="update-details">
      {state.availableVersion && <div className="update-available">
        <strong>Version {state.availableVersion} is available</strong>
        {state.notes && <pre className="update-notes">{state.notes}</pre>}
        <button className="primary-button" disabled={busy || Boolean(selectedAgentId)} onClick={() => void install()}>Update and restart</button>
        {selectedAgentId && <p>Save your changes and close the agent editor before updating.</p>}
      </div>}
      {installingUpdate(state.phase) && <UpdateProgress state={state} />}
      {(error || state.error) && <p className="update-error" role="alert">{error || state.error}</p>}
    </div>}
  </section>;
}

export function UpdateNotice() {
  const { state, dismissedVersion, dismiss, view } = useUpdates();
  if (!state.availableVersion || state.availableVersion === dismissedVersion || installingUpdate(state.phase)) return null;
  return <div className="update-notice" role="status">
    <span>Latch Bar {state.availableVersion} is available</span>
    <button onClick={view}>View update</button>
    <button onClick={dismiss}>Later</button>
  </div>;
}

export function UpdateOverlay() {
  const { state, installing } = useUpdates();
  if (!installing) return null;
  return <div className="update-overlay" role="dialog" aria-modal="true" aria-label="Updating Latch Bar">
    <div className="update-dialog"><h2>Updating Latch Bar</h2>{installingUpdate(state.phase) ? <UpdateProgress state={state} /> : <p role="status">Preparing update…</p>}<p>Please wait. Latch Bar will restart when the update is ready.</p></div>
  </div>;
}
