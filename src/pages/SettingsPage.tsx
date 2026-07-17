import { Check, CircleAlert, ExternalLink, FileCode2, HardDrive, KeyRound, MonitorUp, RotateCcw, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import { Toggle } from "../components/ui";
import { getPlatformStatus, getRuntimeStatus, getStudioShortcutStatus, repairAccessibilityPermission, requestAccessibilityPermission, type PlatformStatus, type RuntimeStatus } from "../services/runtime";
import { useLatch } from "../store/LatchStore";

export function SettingsPage() {
  const { settings, updateSettings, notify } = useLatch();
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
  const row = (title: string, description: string, checked: boolean, onChange: (value: boolean) => void) => <div className="setting-row"><div><strong>{title}</strong><p>{description}</p></div><Toggle checked={checked} onChange={onChange} label={title} /></div>;
  return <div className="page settings-page">
    <div className="settings-tabs">{(["general", "selection", "codex", "privacy", "advanced"] as const).map((item) => <button className={tab === item ? "active" : ""} onClick={() => setTab(item)} key={item}>{item[0].toUpperCase() + item.slice(1)}</button>)}</div>
    {tab === "general" && <div className="settings-panel"><div className="setting-group"><h3>Startup</h3>{row("Launch at login", "Keep Latch ready when you sign in.", settings.launchAtLogin, (value) => updateSettings({ launchAtLogin: value }))}{row("Show menu bar icon", "Access Studio, pause Latch, and see runtime status.", settings.showMenuBar, (value) => updateSettings({ showMenuBar: value }))}</div><div className="setting-group"><h3>Context Bar</h3>{row("Enable Context Bar", "Show favorite profiles after a text selection.", settings.contextBarEnabled, (value) => void setContextBarEnabled(value))}<div className="setting-row shortcut-row"><div><strong>Open Studio shortcut</strong><p>Bring Latch to the front from any application.</p></div><span><kbd>⌥ Space</kbd><small className={shortcutRegistered ? "shortcut-state ready" : "shortcut-state"}>{shortcutRegistered === null ? "Checking" : shortcutRegistered ? "Registered" : "Desktop only"}</small></span></div></div></div>}
    {tab === "selection" && <div className="settings-panel"><div className="runtime-card"><span className="runtime-large-icon"><MonitorUp size={23} /></span><div><span className="eyebrow">NATIVE SELECTION</span><h3>{platform?.accessibilityTrusted ? "Accessibility enabled" : platform?.supported === false ? "Open the desktop app" : "Accessibility permission required"}</h3><p>{platform?.accessibilityTrusted ? `${platform.implementation} is ${platform.monitorRunning && platform.contextBarReady ? "monitoring text selections" : "starting the selection monitor"}.` : "macOS must trust the currently running Latch Bar copy. If the switch is already on but this check fails, repair the stale entry below."}</p></div><button className="secondary-button" onClick={async () => setPlatform(await (platform?.accessibilityTrusted ? getPlatformStatus() : requestAccessibilityPermission()))}>{platform?.accessibilityTrusted ? "Check again" : "Enable Accessibility"}</button></div>{platform?.supported !== false && !platform?.accessibilityTrusted && <div className="setting-group"><h3>Permission switch already enabled?</h3><div className="setting-row"><div><strong>Repair stale Accessibility entry</strong><p>Remove the old code identity from macOS and request access for this installed copy.</p></div><button className="secondary-button" onClick={() => void repairAccessibility()}>Repair permission</button></div></div>}<div className="setting-group"><h3>Selection behavior</h3><div className="setting-row slider-row"><div><strong>Delay before appearing</strong><p>Wait briefly so Latch does not interrupt normal selection.</p></div><label><input type="range" min="0" max="800" step="20" value={settings.selectionDelay} onChange={(event) => updateSettings({ selectionDelay: Number(event.target.value) })} /><b>{settings.selectionDelay} ms</b></label></div><div className="setting-row number-row"><div><strong>Minimum selected characters</strong><p>Ignore accidental or very short selections.</p></div><input type="number" min="1" max="100" value={settings.minimumCharacters} onChange={(event) => updateSettings({ minimumCharacters: Number(event.target.value) })} /></div></div><div className="setting-group"><h3>Excluded applications</h3>{settings.excludedApplications.map((app) => <div className="excluded-app" key={app}><span className="app-token">{app[0]}</span><strong>{app}</strong><span>Protected</span></div>)}</div></div>}
    {tab === "codex" && <div className="settings-panel"><div className="runtime-card"><span className="runtime-large-icon"><FileCode2 size={23} /></span><div><span className="eyebrow">CODEX RUNTIME</span><h3>{runtime?.available === false ? "Codex not found" : "Connected and ready"}</h3><p>{runtime ? runtime.available ? `Version ${runtime.version} · Native app-server` : "Codex is available only from the native desktop app." : "Use your existing Codex installation and authentication."}</p></div><button className="secondary-button" onClick={async () => setRuntime(await getRuntimeStatus())}>Check status</button></div><div className="setting-group"><h3>Installation</h3><div className="setting-row value-row"><div><strong>Codex home</strong><p>Configuration, MCPs, Skills, profiles, and authentication.</p></div><code>{settings.codexHome}</code></div><div className="setting-row value-row"><div><strong>Configuration</strong><p>External source of truth. Latch never stores its secrets.</p></div><button onClick={() => notify("Opening config.toml requires the desktop shell")}>Open config.toml <ExternalLink size={12} /></button></div><div className="setting-row value-row"><div><strong>Authentication</strong><p>Managed by your existing Codex session.</p></div><span className="connected-value"><Check size={12} /> Authenticated</span></div></div></div>}
    {tab === "privacy" && <div className="settings-panel"><div className="privacy-hero"><ShieldCheck size={24} /><div><h3>Your context remains under your control</h3><p>Latch stores profile settings locally and sends selected content only after you choose an agent.</p></div></div><div className="setting-group"><h3>History</h3>{row("Store run history", "Keep run metadata and final responses on this device.", settings.storeHistory, (value) => updateSettings({ storeHistory: value }))}{row("Store original selected text", "Off by default. A hash is kept for correlation instead.", settings.storeSelectedText, (value) => updateSettings({ storeSelectedText: value }))}{row("Redact window titles", "Avoid storing document and browser tab names.", settings.redactWindowTitles, (value) => updateSettings({ redactWindowTitles: value }))}</div><div className="danger-zone"><CircleAlert size={17} /><div><strong>Clear local data</strong><p>Remove agents, run history, and preferences from this device.</p></div><button onClick={() => { localStorage.removeItem("latch-bar-state-v1"); window.location.reload(); }}>Clear data</button></div></div>}
    {tab === "advanced" && <div className="settings-panel"><div className="setting-group"><h3>Runtime</h3><div className="setting-row value-row"><div><strong>App-server executable</strong><p>Binary used for rich Codex integration.</p></div><code>codex app-server</code></div><div className="setting-row value-row"><div><strong>Runtime logs</strong><p>Inspect JSON-RPC events and helper diagnostics.</p></div><button onClick={() => notify("Logs opened in the desktop shell")}>Open logs <MonitorUp size={12} /></button></div></div><div className="advanced-cards"><button><HardDrive /><strong>Export diagnostics</strong><span>Bundle logs without credentials</span></button><button><KeyRound /><strong>Reset integration</strong><span>Reconnect to Codex</span></button><button><RotateCcw /><strong>Reload environment</strong><span>Rescan MCPs and Skills</span></button><button><SlidersHorizontal /><strong>Capabilities</strong><span>View supported runtime options</span></button></div></div>}
  </div>;
}
