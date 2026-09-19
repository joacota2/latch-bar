import { Check, CircleAlert, ExternalLink, FileCode2, HardDrive, KeyRound, MonitorUp, RotateCcw, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { Toggle } from "../components/ui";
import { getPlatformStatus, getRuntimeStatus, getStudioShortcutStatus, repairAccessibilityPermission, requestAccessibilityPermission, type PlatformStatus, type RuntimeStatus } from "../services/runtime";
import { useLatch } from "../store/LatchStore";

export function SettingsPage() {
  const { settings, updateSettings, codexEnvironment, environmentStatus, environmentError, refreshCodexEnvironment, notify } = useLatch();
  const [tab, setTab] = useState<"general" | "selection" | "codex" | "privacy" | "advanced">("general");
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [platform, setPlatform] = useState<PlatformStatus | null>(null);
  const [shortcutRegistered, setShortcutRegistered] = useState<boolean | null>(null);
  useEffect(() => {
    if (tab !== "general") return;
    void getStudioShortcutStatus().then(setShortcutRegistered).catch(() => setShortcutRegistered(false));
  }, [tab]);
  useEffect(() => {
    if (tab !== "selection") return;
    let active = true;
    const refresh = () => void getPlatformStatus().then((status) => { if (active) setPlatform(status); }).catch(() => undefined);
    refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => { active = false; window.clearInterval(timer); };
  }, [tab]);
  useEffect(() => {
    if (tab !== "codex") return;
    void getRuntimeStatus().then(setRuntime).catch(() => undefined);
  }, [tab]);
  const setContextBarEnabled = async (enabled: boolean) => {
    updateSettings({ contextBarEnabled: enabled });
    if (!enabled) {
      notify("Context Bar paused");
      return;
    }
    try {
      const status = await getPlatformStatus();
      setPlatform(status);
      if (!status.supported) {
        notify("Context Bar selection requires the Latch Bar desktop app");
      } else if (!status.accessibilityTrusted) {
        await requestAccessibilityPermission();
        notify("Allow Latch Bar in Accessibility. No restart is needed after approval.");
      } else {
        notify("Context Bar enabled");
      }
    } catch {
      notify("Could not check Accessibility permission");
    }
  };
  const repairAccessibility = async () => {
    try {
      const status = await repairAccessibilityPermission();
      setPlatform(status);
      notify("The stale Accessibility entry was reset. Enable the current Latch Bar copy in macOS Settings.");
    } catch {
      notify("Could not repair Accessibility permission");
    }
  };
  const row = (title: string, description: string, checked: boolean, onChange: (value: boolean) => void, disabled = false) => <div className="setting-row"><div><strong>{title}</strong><p>{description}</p></div><Toggle disabled={disabled} checked={checked} onChange={onChange} label={title} /></div>;
  const checkCodex = async () => {
    const [status] = await Promise.all([getRuntimeStatus(), refreshCodexEnvironment()]);
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
    <div className="settings-tabs">{(["general", "selection", "codex", "privacy", "advanced"] as const).map((item) => <button className={tab === item ? "active" : ""} onClick={() => setTab(item)} key={item}>{item[0].toUpperCase() + item.slice(1)}</button>)}</div>
    {tab === "general" && <div className="settings-panel">
      <div className="setting-group">
        <h3>Startup</h3>
        {row("Launch at login", "Not available in this version.", false, () => undefined, true)}
        {row("Show menu bar icon", "Not available in this version.", false, () => undefined, true)}
      </div>
      <div className="setting-group">
        <h3>Context Bar</h3>
        {row("Enable Context Bar", "Show favorite profiles after a text selection.", settings.contextBarEnabled, (value) => void setContextBarEnabled(value))}
        <div className="setting-row shortcut-row"><div><strong>Open Studio shortcut</strong><p>Bring Latch to the front from any application.</p></div><span><kbd>⌥ Space</kbd><small className={shortcutRegistered ? "shortcut-state ready" : "shortcut-state"}>{shortcutRegistered === null ? "Checking" : shortcutRegistered ? "Registered" : "Desktop only"}</small></span></div>
      </div>
    </div>}
    {tab === "selection" && <div className="settings-panel"><div className="runtime-card"><span className="runtime-large-icon"><MonitorUp size={23} /></span><div><span className="eyebrow">NATIVE SELECTION</span><h3>{platform?.accessibilityTrusted ? "Accessibility enabled" : platform?.supported === false ? "Open the desktop app" : "Accessibility permission required"}</h3><p>{platform?.accessibilityTrusted ? `${platform.implementation} is ${platform.monitorRunning && platform.contextBarReady ? "monitoring text selections" : "starting the selection monitor"}.` : "macOS must trust the currently running Latch Bar copy. If the switch is already on but this check fails, repair the stale entry below."}</p></div><button className="secondary-button" onClick={async () => setPlatform(await (platform?.accessibilityTrusted ? getPlatformStatus() : requestAccessibilityPermission()))}>{platform?.accessibilityTrusted ? "Check again" : "Enable Accessibility"}</button></div>{platform?.supported !== false && !platform?.accessibilityTrusted && <div className="setting-group"><h3>Permission switch already enabled?</h3><div className="setting-row"><div><strong>Repair stale Accessibility entry</strong><p>Remove the old code identity from macOS and request access for this installed copy.</p></div><button className="secondary-button" onClick={() => void repairAccessibility()}>Repair permission</button></div></div>}<div className="setting-group"><h3>Selection behavior</h3><div className="setting-row slider-row"><div><strong>Delay before appearing</strong><p>Wait briefly so Latch does not interrupt normal selection.</p></div><label><input type="range" min="0" max="800" step="20" value={settings.selectionDelay} onChange={(event) => updateSettings({ selectionDelay: Number(event.target.value) })} /><b>{settings.selectionDelay} ms</b></label></div><div className="setting-row number-row"><div><strong>Minimum selected characters</strong><p>Ignore accidental or very short selections.</p></div><input type="number" min="1" max="100" value={settings.minimumCharacters} onChange={(event) => updateSettings({ minimumCharacters: Number(event.target.value) })} /></div></div><div className="setting-group"><h3>Excluded applications</h3>{settings.excludedApplications.map((app) => <div className="excluded-app" key={app}><span className="app-token">{app[0]}</span><strong>{app}</strong><span>Protected</span></div>)}</div></div>}
    {tab === "codex" && <div className="settings-panel">
      <div className="runtime-card"><span className="runtime-large-icon"><FileCode2 size={23} /></span><div><span className="eyebrow">CODEX APP-SERVER</span><h3>{runtime?.available === false ? "Codex not found" : environmentStatus === "error" ? "Codex discovery failed" : environmentStatus === "loading" ? "Discovering Codex environment" : "Connected and ready"}</h3><p>{runtime?.available ? `Version ${runtime.version} · ${codexEnvironment?.models.length ?? 0} models · ${codexEnvironment?.skills.length ?? 0} Skills` : runtime ? "Codex is available only from the native desktop app." : "Using your installed Codex runtime and authentication."}</p></div><button className="secondary-button" disabled={environmentStatus === "loading"} onClick={() => void checkCodex()}>{environmentStatus === "loading" ? "Checking…" : "Check status"}</button></div>
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
    {tab === "privacy" && <div className="settings-panel"><div className="privacy-hero"><ShieldCheck size={24} /><div><h3>Your context remains under your control</h3><p>Latch stores profile settings locally and sends selected content only after you choose an agent.</p></div></div><div className="setting-group"><h3>History</h3>{row("Store run history", "Keep up to 200 runs on this device. Turning this off clears local history; Codex manages its own history.", settings.storeHistory, (value) => updateSettings({ storeHistory: value }))}{row("Store original selected text", "Off by default. Omit the original selection from local run history.", settings.storeSelectedText, (value) => updateSettings({ storeSelectedText: value }))}{row("Redact window titles", "Exclude document and browser tab names from context sent to Codex.", settings.redactWindowTitles, (value) => updateSettings({ redactWindowTitles: value }))}</div><div className="danger-zone"><CircleAlert size={17} /><div><strong>Clear local data</strong><p>Remove agents, run history, and preferences from this device.</p></div><button onClick={() => { localStorage.removeItem("latch-bar-state-v1"); window.location.reload(); }}>Clear data</button></div></div>}
    {tab === "advanced" && <div className="settings-panel"><div className="setting-group"><h3>Runtime</h3><div className="setting-row value-row"><div><strong>App-server executable</strong><p>The highest-version Codex installation resolved by Latch.</p></div><code>{codexEnvironment?.userAgent || "codex app-server"}</code></div><div className="setting-row value-row"><div><strong>Provider capabilities</strong><p>Reported by the active model provider.</p></div><code>{codexEnvironment ? [codexEnvironment.providerCapabilities.webSearch && "web", codexEnvironment.providerCapabilities.imageGeneration && "images", codexEnvironment.providerCapabilities.namespaceTools && "namespaced tools"].filter(Boolean).join(", ") || "none reported" : "not loaded"}</code></div><div className="setting-row value-row"><div><strong>Runtime logs</strong><p>Inspect JSON-RPC events and helper diagnostics.</p></div><button disabled title="Not available in this version">Open logs <MonitorUp size={12} /></button></div></div><div className="advanced-cards"><button disabled title="Not available in this version"><HardDrive /><strong>Export diagnostics</strong><span>Bundle logs without credentials</span></button><button disabled title="Not available in this version"><KeyRound /><strong>Reset integration</strong><span>Reconnect to Codex</span></button><button onClick={() => void refreshCodexEnvironment()}><RotateCcw /><strong>Reload environment</strong><span>Refresh all app-server discovery</span></button><button onClick={() => notify(`${codexEnvironment?.experimentalFeatures.filter((feature) => feature.enabled).length ?? 0} experimental Codex features enabled`)}><SlidersHorizontal /><strong>Capabilities</strong><span>{codexEnvironment?.experimentalFeatures.length ?? 0} feature flags reported</span></button></div></div>}
  </div>;
}
