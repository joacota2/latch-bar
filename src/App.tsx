import { getCurrentWindow } from "@tauri-apps/api/window";
import { TransientResultProvider } from "./store/TransientResultStore";
import { listen } from "@tauri-apps/api/event";
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
import { isTauri, startSelectionMonitor } from "./services/runtime";
import { useEffect, useState } from "react";
import { UpdateProvider, useUpdates } from "./store/UpdateStore";
import { UpdateNotice, UpdateOverlay } from "./components/Updates";
import { PermissionNotice } from "./components/Permissions";
import { PermissionProvider } from "./store/PermissionStore";

const pages = {
  agents: <AgentsPage />,
  runs: <RunsPage />,
  mcps: <McpsPage />,
  skills: <SkillsPage />,
  workspaces: <WorkspacesPage />,
  settings: <SettingsPage />,
};

export function App() {
  return (
    <UpdateProvider>
      <PermissionProvider>
        <TransientResultProvider>
          <Studio />
        </TransientResultProvider>
      </PermissionProvider>
    </UpdateProvider>
  );
}

function Studio() {
  const { installing } = useUpdates();
  const {
    ready,
    persistenceError,
    reloadState,
    activeNav,
    setActiveNav,
    selectedAgentId,
    toasts,
    settings,
    requestCloseEditor,
    notify,
  } = useLatch();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem("latch-sidebar-collapsed") === "true",
  );

  useEffect(() => {
    if (!ready) return;
    void startSelectionMonitor(settings).catch(() => undefined);
  }, [ready, settings]);

  useEffect(() => {
    if (!isTauri()) return;
    const subscription = listen("show-runs", () => setActiveNav("runs"));
    return () => {
      void subscription.then((dispose) => dispose());
    };
  }, [setActiveNav]);

  useEffect(() => {
    if (!isTauri()) return;
    const subscription = getCurrentWindow().onCloseRequested((event) => {
      event.preventDefault();
      void requestCloseEditor()
        .then(async (allowed) => {
          if (allowed) await getCurrentWindow().hide();
        })
        .catch(() =>
          notify("Could not hide Studio. Your saved data is still available."),
        );
    });
    return () => {
      void subscription.then((dispose) => dispose());
    };
  }, [requestCloseEditor, notify]);

  const toggleSidebar = () => {
    setSidebarCollapsed((collapsed) => {
      const next = !collapsed;
      localStorage.setItem("latch-sidebar-collapsed", String(next));
      return next;
    });
  };

  return (
    <div
      className={sidebarCollapsed ? "app-shell sidebar-collapsed" : "app-shell"}
    >
      {persistenceError && (
        <div role="alert" className="info-banner persistence-banner">
          {persistenceError}
          <button onClick={() => void reloadState()}>Retry</button>
        </div>
      )}
      {!ready && !persistenceError && (
        <p className="info-banner persistence-banner" role="status">
          Loading local data…
        </p>
      )}
      <div className="studio-content" inert={installing || !ready}>
        <Sidebar collapsed={sidebarCollapsed} onToggle={toggleSidebar} />
        <div className="app-main">
          <Topbar />
          <UpdateNotice />
          <PermissionNotice />
          <main className="page-scroll">{pages[activeNav]}</main>
        </div>
        {selectedAgentId && <AgentEditor />}
        <div className="toast-stack" aria-live="polite">
          {toasts.map((toast) => (
            <div className="toast" key={toast.id}>
              <span>✓</span>
              {toast.message}
            </div>
          ))}
        </div>
      </div>
      <UpdateOverlay />
    </div>
  );
}
