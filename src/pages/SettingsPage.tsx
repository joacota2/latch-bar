import { Check, CircleAlert, ExternalLink, FileCode2, ShieldCheck } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { Toggle } from "../components/ui";
import { getRuntimeStatus, getStudioShortcutStatus, type RuntimeStatus } from "../services/runtime";
import { useLatch } from "../store/LatchStore";
import { useUpdates } from "../store/UpdateStore";
import { UpdatesPanel } from "../components/Updates";
import { PermissionsPanel } from "../components/Permissions";
import { needsPermissionSetup, usePermissions } from "../store/PermissionStore";

const tabs = ["general", "permissions", "selection", "codex", "privacy"] as const;
type SettingsTab = typeof tabs[number];

export function SettingsPage() {
  const { clearData, settings, updateSettings, codexEnvironment, environmentStatus, environmentError, refreshCodexEnvironment, notify } = useLatch();
  const { needsSetup, refresh, viewRequest: permissionsRequest } = usePermissions();
  const [tab, setTab] = useState<SettingsTab>(() => needsSetup ? "permissions" : "general");
  const { viewRequest } = useUpdates();
  useEffect(() => { if (viewRequest) setTab("general"); }, [viewRequest]);
  useEffect(() => { if (permissionsRequest) setTab("permissions"); }, [permissionsRequest]);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [shortcutRegistered, setShortcutRegistered] = useState<boolean | null>(null);
  useEffect(() => {
    if (tab !== "general") return;
    void getStudioShortcutStatus().then(setShortcutRegistered).catch(() => setShortcutRegistered(false));
  }, [tab]);
  useEffect(() => {
    if (tab !== "codex") return;
    void getRuntimeStatus().then(setRuntime).catch(() => undefined);
  }, [tab]);
  const setContextBarEnabled = async (enabled: boolean) => {
    if (!await updateSettings({ contextBarEnabled: enabled })) return;
    if (!enabled) {
      notify("Context Bar paused");
      return;
    }
    const status = await refresh();
    if (!status?.supported) {
      notify("Context Bar selection requires the Latch Bar desktop app");
    } else if (needsPermissionSetup(status)) {
      setTab("permissions");
      notify("Finish permission setup to use the Context Bar");
    } else {
      notify("Context Bar enabled");
    }
  };
  const row = (title: string, description: string, checked: boolean, onChange: (value: boolean) => void, disabled = false) => <div className="setting-row"><div><strong>{title}</strong><p>{description}</p></div><Toggle disabled={disabled} checked={checked} onChange={onChange} label={title} /></div>;
  const checkCodex = async () => {
    const [status] = await Promise.all([getRuntimeStatus(true), refreshCodexEnvironment(undefined, undefined, true)]);
    setRuntime(status);
  };
  const accountLabel = codexEnvironment?.account.signedIn
    ? "Authenticated"
    : codexEnvironment && !codexEnvironment.account.requiresOpenaiAuth
      ? "Not required"
      : environmentStatus === "loading"
        ? "Checking"
        : "Not authenticated";
  return <div className="page settings-page">
    <div className="settings-tabs">{tabs.map((item) => <button className={tab === item ? "active" : ""} onClick={() => setTab(item)} key={item}>{item[0].toUpperCase() + item.slice(1)}</button>)}</div>
    {tab === "general" && <div className="settings-panel">
      <UpdatesPanel />
      <div className="setting-group">
        <h3>Context Bar</h3>
        {row("Enable Context Bar", "Show favorite profiles after a text selection.", settings.contextBarEnabled, (value) => void setContextBarEnabled(value))}
        <div className="setting-row shortcut-row"><div><strong>Open Studio shortcut</strong><p>Bring Latch to the front from any application.</p></div><span><kbd>⌥ Space</kbd><small className={shortcutRegistered ? "shortcut-state ready" : "shortcut-state"}>{shortcutRegistered === null ? "Checking" : shortcutRegistered ? "Registered" : "Desktop only"}</small></span></div>
      </div>
    </div>}
    {tab === "selection" && <div className="settings-panel">{needsSetup && <div className="info-banner selection-permission-banner"><CircleAlert size={18} /><div><strong>Accessibility is not allowed yet</strong><p>The Context Bar cannot see selections until permission setup is finished.</p></div><button className="secondary-button" onClick={() => setTab("permissions")}>Open Permissions</button></div>}<div className="setting-group"><h3>Selection behavior</h3><div className="setting-row slider-row"><div><strong>Delay before appearing</strong><p>Wait briefly so Latch does not interrupt normal selection.</p></div><label><input type="range" min="0" max="800" step="20" value={settings.selectionDelay} onChange={(event) => updateSettings({ selectionDelay: Number(event.target.value) })} /><b>{settings.selectionDelay} ms</b></label></div><div className="setting-row number-row"><div><strong>Minimum selected characters</strong><p>Ignore accidental or very short selections.</p></div><input type="number" min="1" max="100" value={settings.minimumCharacters} onChange={(event) => updateSettings({ minimumCharacters: Number(event.target.value) })} /></div></div><div className="setting-group"><h3>Excluded applications</h3>{settings.excludedApplications.map((app) => <div className="excluded-app" key={app}><span className="app-token">{app[0]}</span><strong>{app}</strong><span>Protected</span></div>)}</div></div>}
    {tab === "permissions" && <PermissionsPanel onOpenCodex={() => setTab("codex")} />}
    {tab === "codex" && <div className="settings-panel">
      <div className="runtime-card"><span className="runtime-large-icon"><FileCode2 size={23} /></span><div><span className="eyebrow">CODEX APP-SERVER</span><h3>{runtime?.available === false ? "Codex not found" : environmentStatus === "error" ? "Codex discovery failed" : environmentStatus === "loading" ? "Discovering Codex environment" : "Connected and ready"}</h3><p>{runtime?.available ? `Version ${runtime.version} · ${codexEnvironment?.models.length ?? 0} models · ${codexEnvironment?.skills.length ?? 0} Skills${runtime.path ? ` · ${runtime.path}` : ""}` : runtime ? "Install the Codex app or the Codex CLI, sign in, then check again." : "Using your installed Codex runtime and authentication."}</p></div><button className="secondary-button" disabled={environmentStatus === "loading"} onClick={() => void checkCodex()}>{environmentStatus === "loading" ? "Checking…" : "Check status"}</button></div>
      {environmentError && <div className="info-banner"><CircleAlert size={18} /><div><strong>Discovery error</strong><p>{environmentError}</p></div></div>}
      {codexEnvironment?.errors.map((error) => <div className="info-banner" key={error}><CircleAlert size={18} /><div><strong>Partial Codex response</strong><p>{error}</p></div></div>)}
      <div className="setting-group"><h3>Installation</h3>
        <div className="setting-row value-row"><div><strong>Codex home</strong><p>Reported by the initialized app-server.</p></div><code>{codexEnvironment?.codexHome || runtime?.codexHome || "Not reported"}</code></div>
        <div className="setting-row value-row"><div><strong>Configuration</strong><p>Effective configuration source; secrets remain inside Codex.</p></div><button disabled={!codexEnvironment?.configPath} onClick={() => void revealItemInDir(codexEnvironment!.configPath).catch(() => notify("Could not show the Codex configuration file"))}>{codexEnvironment?.configPath ?? "config.toml"} <ExternalLink size={12} /></button></div>
        <div className="setting-row value-row"><div><strong>Authentication</strong><p>{codexEnvironment?.account.accountType ? `${codexEnvironment.account.accountType}${codexEnvironment.account.planType ? ` · ${codexEnvironment.account.planType}` : ""}` : "Managed by Codex."}</p></div><span className={codexEnvironment?.account.signedIn ? "connected-value" : ""}>{codexEnvironment?.account.signedIn && <Check size={12} />} {accountLabel}</span></div>
      </div>
      <div className="setting-group"><h3>Effective defaults</h3>
        <div className="setting-row value-row"><div><strong>Model</strong><p>Resolved from the current Codex configuration.</p></div><code>{codexEnvironment?.effectiveConfig.model ?? codexEnvironment?.models.find((model) => model.isDefault)?.model ?? "Codex default"}</code></div>
        <div className="setting-row value-row"><div><strong>Reasoning and service tier</strong><p>Used when an agent inherits defaults.</p></div><code>{codexEnvironment ? `${codexEnvironment.effectiveConfig.reasoningEffort ?? "default"} · ${codexEnvironment.effectiveConfig.serviceTier ?? "default"}` : "default"}</code></div>
        <div className="setting-row value-row"><div><strong>Access defaults</strong><p>Effective approval and permission configuration.</p></div><code>{codexEnvironment ? `${codexEnvironment.effectiveConfig.approvalPolicy ?? "default"} · ${codexEnvironment.effectiveConfig.permissionProfile ?? codexEnvironment.effectiveConfig.sandboxMode ?? "default"}` : "default"}</code></div>
      </div>
    </div>}
    {tab === "privacy" && <div className="settings-panel"><div className="privacy-hero"><ShieldCheck size={24} /><div><h3>Your context remains under your control</h3><p>Latch stores profile settings locally and sends selected content only after you choose an agent.</p></div></div><div className="setting-group"><h3>History</h3>{row("Store run history", "Keep up to 200 runs on this device. Turning this off clears local history; Codex manages its own history.", settings.storeHistory, (value) => updateSettings({ storeHistory: value }))}{row("Store original selected text", "Off by default. Omit the original selection from local run history.", settings.storeSelectedText, (value) => updateSettings({ storeSelectedText: value }))}{row("Redact window titles", "Exclude document and browser tab names from context sent to Codex.", settings.redactWindowTitles, (value) => updateSettings({ redactWindowTitles: value }))}</div><div className="danger-zone"><CircleAlert size={17} /><div><strong>Clear local data</strong><p>Remove agents, run history, and preferences from this device.</p></div><button onClick={() => void clearData()}>Clear data</button></div></div>}
  </div>;
}
