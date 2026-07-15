import { Bot, Braces, Cable, ChevronsLeft, Clock3, FolderKanban, Settings2 } from "lucide-react";
import type { NavKey } from "../domain";
import { useLatch } from "../store/LatchStore";

const navItems: { key: NavKey; label: string; icon: typeof Bot }[] = [
  { key: "agents", label: "Agents", icon: Bot },
  { key: "runs", label: "Runs", icon: Clock3 },
  { key: "mcps", label: "MCPs", icon: Cable },
  { key: "skills", label: "Skills", icon: Braces },
  { key: "workspaces", label: "Workspaces", icon: FolderKanban },
];

export function Sidebar() {
  const { activeNav, setActiveNav, runs } = useLatch();
  const attention = runs.filter((run) => run.status === "approval").length;

  return (
    <aside className="sidebar">
      <div className="traffic-lights" aria-hidden="true"><i /><i /><i /></div>
      <button className="brand" onClick={() => setActiveNav("agents")} aria-label="Latch home">
        <span className="brand-mark"><span /></span>
        <span><b>latch</b><small>bar</small></span>
      </button>
      <nav className="primary-nav" aria-label="Main navigation">
        {navItems.map(({ key, label, icon: Icon }) => (
          <button key={key} className={activeNav === key ? "nav-item active" : "nav-item"} onClick={() => setActiveNav(key)}>
            <Icon size={18} strokeWidth={1.9} />
            <span>{label}</span>
            {key === "runs" && attention > 0 && <span className="nav-badge">{attention}</span>}
          </button>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <div className="runtime-pill"><span className="status-dot" /><div><strong>Codex connected</strong><small>v0.133.0 · Local</small></div></div>
        <button className={activeNav === "settings" ? "nav-item active" : "nav-item"} onClick={() => setActiveNav("settings")}>
          <Settings2 size={18} /><span>Settings</span>
        </button>
        <button className="collapse-button" aria-label="Collapse sidebar"><ChevronsLeft size={16} /></button>
      </div>
    </aside>
  );
}
