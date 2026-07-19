import { FolderGit2, FolderOpen, GitBranch, MoreHorizontal, Plus, Radar, Search } from "lucide-react";
import { PageIntro } from "../components/ui";
import { useLatch } from "../store/LatchStore";

export function WorkspacesPage() {
  const { workspaces, environmentStatus, refreshCodexEnvironment, notify } = useLatch();
  return <div className="page catalog-page">
    <PageIntro eyebrow="CODEX THREAD HISTORY" title="Workspaces" description="Recent working directories and Git branches reported by Codex, ready for reuse by Latch agents." action={<button className="primary-button" onClick={() => notify("Native folder picker opens in the Tauri app")}><Plus size={15} /> Add workspace</button>} />
    <div className="workspace-detection"><span><Radar size={18} /></span><div><strong>Codex workspace discovery</strong><p>Derived from recent Codex threads instead of a separate hardcoded project list.</p></div><span className="enabled-pill">{environmentStatus === "loading" ? "Refreshing" : `${workspaces.length} recent`}</span></div>
    <div className="workspace-list">
      {workspaces.map((workspace) => <article className="workspace-row" key={workspace.id}>
        <span className="workspace-folder" style={{ "--workspace-color": workspace.color } as React.CSSProperties}><FolderGit2 size={21} /></span>
        <div><h3>{workspace.name}</h3><p>{workspace.path}</p></div>
        <span className="branch"><GitBranch size={13} />{workspace.branch}</span>
        <span className="last-used">Last used<strong>{workspace.lastUsed}</strong></span>
        <button className="ghost-icon" aria-label="Workspace menu"><MoreHorizontal size={18} /></button>
      </article>)}
      {workspaces.length === 0 && <div className="info-banner"><FolderGit2 size={19} /><div><strong>{environmentStatus === "loading" ? "Loading recent workspaces" : "No recent Codex workspaces"}</strong><p>Start a Codex thread in a project or choose a folder to add one.</p></div></div>}
    </div>
    <div className="workspace-empty-actions"><button onClick={() => notify("Native folder picker opens in the desktop app")}><FolderOpen size={18} /><strong>Choose another folder</strong><span>Add any local project</span></button><button onClick={() => void refreshCodexEnvironment()}><Search size={18} /><strong>Refresh from Codex</strong><span>Reload recent thread directories</span></button></div>
  </div>;
}
