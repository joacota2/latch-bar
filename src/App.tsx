import { AgentEditor } from "./components/AgentEditor";
import { ContextBar } from "./components/ContextBar";
import { Sidebar } from "./components/Sidebar";
import { StudioRun } from "./components/StudioRun";
import { Topbar } from "./components/Topbar";
import { AgentsPage } from "./pages/AgentsPage";
import { McpsPage } from "./pages/McpsPage";
import { RunsPage } from "./pages/RunsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SkillsPage } from "./pages/SkillsPage";
import { WorkspacesPage } from "./pages/WorkspacesPage";
import { useLatch } from "./store/LatchStore";

const pages = {
  agents: <AgentsPage />,
  runs: <RunsPage />,
  mcps: <McpsPage />,
  skills: <SkillsPage />,
  workspaces: <WorkspacesPage />,
  settings: <SettingsPage />,
};

export function App() {
  const { activeNav, selectedAgentId, studioExpanded, toasts } = useLatch();

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="app-main">
        <Topbar />
        <main className="page-scroll">{pages[activeNav]}</main>
      </div>
      {selectedAgentId && <AgentEditor />}
      {studioExpanded && <StudioRun />}
      <ContextBar />
      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => <div className="toast" key={toast.id}><span>✓</span>{toast.message}</div>)}
      </div>
    </div>
  );
}
