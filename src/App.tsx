import { AgentEditor } from "./components/AgentEditor";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { AgentsPage } from "./pages/AgentsPage";
import { McpsPage } from "./pages/McpsPage";
import { RunsPage } from "./pages/RunsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SkillsPage } from "./pages/SkillsPage";
import { WorkspacesPage } from "./pages/WorkspacesPage";
import { useLatch } from "./store/LatchStore";
import { getPlatformStatus, isTauri, startSelectionMonitor } from "./services/runtime";
import { useEffect, useRef, useState } from "react";

const pages = {
  agents: <AgentsPage />,
  runs: <RunsPage />,
  mcps: <McpsPage />,
  skills: <SkillsPage />,
  workspaces: <WorkspacesPage />,
  settings: <SettingsPage />,
};

export function App() {
  const { activeNav, selectedAgentId, toasts, settings, notify } = useLatch();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("latch-sidebar-collapsed") === "true");
  const permissionPrompted = useRef(false);

  useEffect(() => {
    void startSelectionMonitor(settings).catch(() => undefined);
  }, [settings]);

  useEffect(() => {
    if (!isTauri() || !settings.contextBarEnabled || permissionPrompted.current) return;
    permissionPrompted.current = true;
    void getPlatformStatus(false).then(async (status) => {
      if (!status.supported || status.accessibilityTrusted) return;
      await getPlatformStatus(true);
      notify("Allow Latch Bar in Accessibility. It will start working without a restart.");
    }).catch(() => notify("Could not check Accessibility permission"));
  }, [notify, settings.contextBarEnabled]);

  const toggleSidebar = () => {
    setSidebarCollapsed((collapsed) => {
      const next = !collapsed;
      localStorage.setItem("latch-sidebar-collapsed", String(next));
      return next;
    });
  };

  return (
    <div className={sidebarCollapsed ? "app-shell sidebar-collapsed" : "app-shell"}>
      <Sidebar collapsed={sidebarCollapsed} onToggle={toggleSidebar} />
      <div className="app-main">
        <Topbar />
        <main className="page-scroll">{pages[activeNav]}</main>
      </div>
      {selectedAgentId && <AgentEditor />}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => <div className="toast" key={toast.id}><span>✓</span>{toast.message}</div>)}
      </div>
    </div>
  );
}
