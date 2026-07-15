import { FolderGit2, FolderOpen, GitBranch, MoreHorizontal, Plus, Radar, Search } from "lucide-react";
import { PageIntro } from "../components/ui";
import { useLatch } from "../store/LatchStore";

export function WorkspacesPage() {
  const { workspaces, notify } = useLatch();
  return <div className="page catalog-page">
    <PageIntro eyebrow="PROJECT CONTEXT" title="Workspaces" description="Connect selected content to the right local project, while keeping each agent inside its configured sandbox." action={<button className="primary-button" onClick={() => notify("Native folder picker opens in the Tauri app")}><Plus size={15} /> Add workspace</button>} />
    <div className="workspace-detection"><span><Radar size={18} /></span><div><strong>Automatic workspace detection</strong><p>Match the active file or application to a recent Git repository.</p></div><span className="enabled-pill">Enabled</span></div>
    <div className="workspace-list">
      {workspaces.map((workspace) => <article className="workspace-row" key={workspace.id}>
        <span className="workspace-folder" style={{ "--workspace-color": workspace.color } as React.CSSProperties}><FolderGit2 size={21} /></span>
        <div><h3>{workspace.name}</h3><p>{workspace.path}</p></div>
        <span className="branch"><GitBranch size={13} />{workspace.branch}</span>
        <span className="last-used">Last used<strong>{workspace.lastUsed}</strong></span>
        <button className="ghost-icon" aria-label="Workspace menu"><MoreHorizontal size={18} /></button>
      </article>)}
    </div>
    <div className="workspace-empty-actions"><button onClick={() => notify("Native folder picker opens in the desktop app")}><FolderOpen size={18} /><strong>Choose another folder</strong><span>Add any local project</span></button><button onClick={() => notify("Scanning recent repositories…")}><Search size={18} /><strong>Scan recent projects</strong><span>Find Git repositories automatically</span></button></div>
  </div>;
}
