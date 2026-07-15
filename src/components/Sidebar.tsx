import { Bot, Braces, Cable, ChevronsLeft, ChevronsRight, Clock3, FolderKanban, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { NavKey } from "../domain";
import { getRuntimeStatus, type RuntimeStatus } from "../services/runtime";
import { useLatch } from "../store/LatchStore";

const navItems: { key: NavKey; label: string; icon: typeof Bot }[] = [
  { key: "agents", label: "Agents", icon: Bot },
  { key: "runs", label: "Runs", icon: Clock3 },
  { key: "mcps", label: "MCPs", icon: Cable },
  { key: "skills", label: "Skills", icon: Braces },
  { key: "workspaces", label: "Workspaces", icon: FolderKanban },
];

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { activeNav, setActiveNav, runs } = useLatch();
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const attention = runs.filter((run) => run.status === "approval").length;

  useEffect(() => {
    void getRuntimeStatus().then(setRuntime).catch(() => setRuntime(null));
  }, []);

  const connected = runtime?.available === true;
  return (
    <aside className="sidebar" aria-label="Studio sidebar">
      <button className="brand" onClick={() => setActiveNav("agents")} aria-label="Latch home" title={collapsed ? "Latch Bar" : undefined}>
        <img className="brand-icon" src="/latch-icon.svg" alt="" />
        <span className="brand-word"><b>latch</b><small>bar</small></span>
      </button>
      <nav className="primary-nav" aria-label="Main navigation">
        {navItems.map(({ key, label, icon: Icon }) => (
          <button key={key} aria-label={label} title={collapsed ? label : undefined} className={activeNav === key ? "nav-item active" : "nav-item"} onClick={() => setActiveNav(key)}>
            <Icon size={18} strokeWidth={1.9} />
            <span className="nav-label">{label}</span>
            {key === "runs" && attention > 0 && <span className="nav-badge">{attention}</span>}
          </button>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <div className={connected ? "runtime-pill" : "runtime-pill unavailable"} title={runtime ? connected ? `Codex ${runtime.version}` : "Codex unavailable" : "Checking Codex runtime"}>
          <span className="status-dot" />
          <div><strong>{runtime ? connected ? "Codex connected" : "Codex unavailable" : "Checking Codex"}</strong><small>{connected ? `${runtime.version} · Local` : "Desktop runtime"}</small></div>
        </div>
        <button aria-label="Settings" title={collapsed ? "Settings" : undefined} className={activeNav === "settings" ? "nav-item active" : "nav-item"} onClick={() => setActiveNav("settings")}>
          <Settings2 size={18} /><span className="nav-label">Settings</span>
        </button>
        <button className="collapse-button" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed} onClick={onToggle} title={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
          {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
        </button>
      </div>
    </aside>
  );
}
