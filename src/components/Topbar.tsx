import { CircleHelp, Search, Sparkles } from "lucide-react";
import { useLatch } from "../store/LatchStore";

const labels = {
  agents: ["Agents", "Create specialized Codex profiles for any context."],
  runs: ["Runs", "See what Codex is doing and what needs your attention."],
  mcps: ["MCP servers", "Tools available from your existing Codex configuration."],
  skills: ["Skills", "Reusable workflows already available to Codex."],
  workspaces: ["Workspaces", "Projects Latch can connect to selected context."],
  settings: ["Settings", "Control Latch, Codex, selection behavior, and privacy."],
};

export function Topbar() {
  const { activeNav, settings, updateSettings, notify } = useLatch();
  return (
    <header className="topbar">
      <div className="topbar-copy"><h1>{labels[activeNav][0]}</h1><p>{labels[activeNav][1]}</p></div>
      <div className="topbar-actions">
        <button className="search-button" onClick={() => notify("Global search is ready for the next iteration")}><Search size={16} /><span>Search</span><kbd>⌘ K</kbd></button>
        <button className="icon-button" aria-label="Help" onClick={() => notify("Help center opened")}><CircleHelp size={18} /></button>
        <button className={settings.contextBarEnabled ? "bar-status on" : "bar-status"} onClick={() => updateSettings({ contextBarEnabled: !settings.contextBarEnabled })}>
          <Sparkles size={15} /><span>Context Bar</span><i />
        </button>
      </div>
    </header>
  );
}
