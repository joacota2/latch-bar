import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AppSettings, CodexAgent, CodexEnvironment, CodexSkill, ContextBarState, McpServer, NavKey, Run, Workspace } from "../domain";
import { seedAgents } from "../data/seed";
import { isTauri, scanCodexEnvironment } from "../services/runtime";
import { completeState } from "../services/persistedState";
import { readState, changeState, subscribeState, type Snapshot, type Change } from "../services/persistence";
import { agentConfigSchema } from "../services/agentConfig";

interface Toast { id: number; message: string }

interface LatchState {
  ready: boolean;
  persistenceError: string;
  reloadState: () => Promise<void>;
  resetEpoch: string;
  clearData: () => Promise<void>;
  recentWorkspace: string | undefined;
  helpRequest: number;
  openHelp: () => void;
  activeNav: NavKey;
  setActiveNav: (nav: NavKey) => void;
  agents: CodexAgent[];
  selectedAgentId: string | null;
  setSelectedAgentId: (id: string | null) => void;
  createAgent: (workspacePath?: string) => Promise<string | null>;
  updateAgent: (agent: CodexAgent) => Promise<boolean>;
  duplicateAgent: (id: string) => Promise<void>;
  deleteAgent: (id: string) => Promise<void>;
  togglePin: (id: string) => Promise<boolean>;
  toggleEnabled: (id: string) => Promise<boolean>;
  mcps: McpServer[];
  skills: CodexSkill[];
  workspaces: Workspace[];
  addWorkspace: (path: string) => Promise<boolean>;
  removeWorkspace: (path: string) => Promise<boolean>;
  codexEnvironment: CodexEnvironment | null;
  environmentStatus: "idle" | "loading" | "ready" | "unavailable" | "error";
  environmentError: string;
  refreshCodexEnvironment: (workspacePath?: string, profile?: string) => Promise<CodexEnvironment | null>;
  runs: Run[];
  upsertRun: (run: Run, epoch?: string) => Promise<boolean>;
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => Promise<boolean>;
  contextBarState: ContextBarState;
  setContextBarState: (state: ContextBarState) => void;
  contextAgentId: string | null;
  setContextAgentId: (id: string | null) => void;
  contextResult: string;
  setContextResult: (result: string) => void;
  studioExpanded: boolean;
  setStudioExpanded: (expanded: boolean) => void;
  toasts: Toast[];
  notify: (message: string) => void;
}

const StoreContext = createContext<LatchState | null>(null);
export function LatchProvider({ children }: { children: ReactNode }) {
  const initial = useMemo(() => completeState(null), []);
  const [ready, setReady] = useState(false);
  const [persistenceError, setPersistenceError] = useState("");
  const snapshotRef = useRef<Snapshot | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const [resetEpoch, setResetEpoch] = useState("");
  const [helpRequest, setHelpRequest] = useState(0);
  const [activeNav, setActiveNav] = useState<NavKey>("agents");
  const [agents, setAgents] = useState<CodexAgent[]>(initial.agents);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[]>(initial.runs);
  const [mcps, setMcps] = useState<McpServer[]>([]);
  const [skills, setSkills] = useState<CodexSkill[]>([]);
  const [discoveredWorkspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [savedWorkspaces, setSavedWorkspaces] = useState<Workspace[]>(initial.savedWorkspaces);
  const workspaces = useMemo(() => [...savedWorkspaces, ...discoveredWorkspaces.filter((item) => !savedWorkspaces.some((saved) => saved.path === item.path))], [savedWorkspaces, discoveredWorkspaces]);
  const [codexEnvironment, setCodexEnvironment] = useState<CodexEnvironment | null>(null);
  const [environmentStatus, setEnvironmentStatus] = useState<LatchState["environmentStatus"]>("idle");
  const [environmentError, setEnvironmentError] = useState("");
  const [settings, setSettings] = useState<AppSettings>(initial.settings);
  const [contextBarState, setContextBarState] = useState<ContextBarState>("idle");
  const [contextAgentId, setContextAgentId] = useState<string | null>(null);
  const [contextResult, setContextResult] = useState("");
  const [studioExpanded, setStudioExpanded] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const environmentRequestId = useRef(0);
  const toastId = useRef(0);

  const refreshCodexEnvironment = useCallback(async (workspacePath?: string, profile?: string) => {
    const requestId = ++environmentRequestId.current;
    if (!isTauri()) {
      if (requestId === environmentRequestId.current) setEnvironmentStatus("unavailable");
      return null;
    }
    setEnvironmentStatus("loading");
    setEnvironmentError("");
    try {
      const environment = await scanCodexEnvironment(workspacePath, profile);
      if (!environment) {
        if (requestId === environmentRequestId.current) setEnvironmentStatus("unavailable");
        return null;
      }
      if (requestId === environmentRequestId.current) {
        setCodexEnvironment(environment);
        setMcps(environment.mcpServers);
        setSkills(environment.skills);
        setWorkspaces(environment.workspaces);
        setEnvironmentStatus("ready");
      }
      return environment;
    } catch (caught) {
      if (requestId === environmentRequestId.current) {
        setEnvironmentError(caught instanceof Error ? caught.message : String(caught));
        setEnvironmentStatus("error");
      }
      return null;
    }
  }, []);

  useEffect(() => { void refreshCodexEnvironment(); }, [refreshCodexEnvironment]);

  const notify = useCallback((message: string) => {
    const id = ++toastId.current;
    setToasts((items) => [...items, { id, message }]);
    window.setTimeout(() => setToasts((items) => items.filter((item) => item.id !== id)), 4000);
  }, []);
  const applySnapshot = useCallback((snapshot: Snapshot) => {
    const previous = snapshotRef.current;
    // Legacy browser storage removal has revision zero. All committed
    // snapshots are monotonic, including refreshes racing a local write.
    if (previous && previous.revision > snapshot.revision && (isTauri() || snapshot.revision > 0)) return;
    if (previous && previous.epoch !== snapshot.epoch) setSelectedAgentId(null);
    snapshotRef.current = snapshot;
    setResetEpoch(snapshot.epoch);
    setAgents(snapshot.state.agents); setRuns(snapshot.state.runs);
    setSettings(snapshot.state.settings); setSavedWorkspaces(snapshot.state.savedWorkspaces);
    setReady(true);
  }, []);
  const reloadState = useCallback(async () => {
    try { applySnapshot(await readState()); setPersistenceError(""); }
    catch (error) { setPersistenceError(`Could not load local data: ${String(error)}`); }
  }, [applySnapshot]);
  useEffect(() => {
    let disposed = false;
    const refresh = () => { if (!disposed) void reloadState(); };
    const subscription = subscribeState(refresh);
    void subscription.then(refresh).catch((error) => setPersistenceError(String(error)));
    return () => { disposed = true; void subscription.then((unlisten) => unlisten()).catch(() => undefined); };
  }, [reloadState]);

  const commit = useCallback((change: Change, reset = false, epoch = snapshotRef.current?.epoch): Promise<boolean> => {
    const task = async () => {
      try {
        if (!epoch) throw new Error("Local data is still loading. Please try again.");
        const next = await changeState(change, epoch, reset);
        if (!next) { await reloadState(); return false; }
        applySnapshot(next); setPersistenceError(""); return true;
      } catch (error) {
        const message = `Could not save changes: ${error instanceof Error ? error.message : String(error)}`;
        setPersistenceError(message); notify(message); return false;
      }
    };
    const result = queue.current.then(task, task);
    queue.current = result;
    return result;
  }, [applySnapshot, notify, reloadState]);

  const clearData = useCallback(async () => {
    if (await commit(() => completeState(null), true)) notify("Local data cleared");
  }, [commit, notify]);
  const updateAgent = useCallback(async (agent: CodexAgent) => {
    const valid = agentConfigSchema.safeParse(agent);
    if (!valid.success) { notify(`Invalid agent: ${valid.error.issues[0].path.join(".")} ${valid.error.issues[0].message}`); return false; }
    return commit((current) => ({ ...current, agents: current.agents.map((item) => item.id === agent.id ? { ...agent, ...valid.data, updatedAt: new Date().toISOString() } : item) }));
  }, [commit, notify]);

  const createAgent = useCallback(async (workspacePath?: string) => {
    const id = `agent-${crypto.randomUUID()}`;
    const saved = await commit((current) => ({ ...current, agents: [...current.agents, {
      ...seedAgents[0], id, name: "Untitled agent", description: "Describe what this Codex profile should do.", icon: "✦", pinned: false,
      order: current.agents.length, workspaceMode: workspacePath ? "fixed" : "none", fixedWorkspacePath: workspacePath, enabledMcpServers: [], enabledSkills: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }] }));
    if (saved) setSelectedAgentId(id);
    return saved ? id : null;
  }, [commit]);

  const duplicateAgent = useCallback(async (id: string) => {
    const saved = await commit((current) => {
      const source = current.agents.find((item) => item.id === id);
      return source ? { ...current, agents: [...current.agents, { ...source, id: crypto.randomUUID(), name: `${source.name} copy`, pinned: false, order: current.agents.length, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] } : current;
    });
    if (saved) notify("Agent duplicated");
  }, [commit, notify]);

  const deleteAgent = useCallback(async (id: string) => {
    const saved = await commit((current) => ({ ...current, agents: current.agents.filter((item) => item.id !== id) }));
    if (saved) { setSelectedAgentId(null); notify("Agent removed"); }
  }, [commit, notify]);

  const patchAgent = useCallback((id: string, field: "pinned" | "enabled") => {
    return commit((current) => ({ ...current, agents: current.agents.map((item) => item.id === id ? { ...item, [field]: !item[field], updatedAt: new Date().toISOString() } : item) }));
  }, [commit]);

  const upsertRun = useCallback((run: Run, epoch?: string) => {
    return commit((current) => {
      // A stopped child can still deliver a queued EOF/error notification.
      if (current.runs.some((item) => item.id === run.id && item.status === "cancelled")) return current;
      return { ...current, runs: [run, ...current.runs.filter((item) => item.id !== run.id)] };
    }, false, epoch);
  }, [commit]);

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    return commit((current) => ({ ...current, settings: { ...current.settings, ...patch },
      runs: patch.contextBarEnabled === false ? current.runs.map((run) =>
        run.status === "running" || run.status === "approval"
          ? { ...run, status: "cancelled", activity: "Cancelled when Context Bar was paused" } : run) : current.runs,
    }));
  }, [commit]);

  const addWorkspace = useCallback((path: string) => {
    const normalized = path.replace(/\/+$/, "") || "/";
    return commit((current) => ({ ...current, savedWorkspaces: [{ saved: true, id: normalized, path: normalized, name: normalized.split("/").pop() || normalized, branch: "—", lastUsed: "Saved", color: "#c8f46a" }, ...current.savedWorkspaces.filter((item) => item.path !== normalized)] }));
  }, [commit]);
  const removeWorkspace = useCallback((path: string) => {
    return commit((current) => ({ ...current, savedWorkspaces: current.savedWorkspaces.filter((item) => item.path !== path) }));
  }, [commit]);

  const value = useMemo<LatchState>(() => ({
    activeNav, setActiveNav,
    agents, selectedAgentId, setSelectedAgentId, createAgent, updateAgent, duplicateAgent, deleteAgent,
    togglePin: (id) => patchAgent(id, "pinned"),
    toggleEnabled: (id) => patchAgent(id, "enabled"),
    mcps, skills, workspaces, addWorkspace, removeWorkspace,
    codexEnvironment, environmentStatus, environmentError, refreshCodexEnvironment,
    runs, upsertRun,
    settings, updateSettings,
    contextBarState, setContextBarState, contextAgentId, setContextAgentId, contextResult, setContextResult,
    studioExpanded, setStudioExpanded,
    toasts, notify, ready, persistenceError, reloadState, resetEpoch, clearData,
    recentWorkspace: discoveredWorkspaces[0]?.path, helpRequest, openHelp: () => setHelpRequest((n) => n + 1),
  }), [toasts, ready, persistenceError, reloadState, resetEpoch, clearData, discoveredWorkspaces, helpRequest, addWorkspace, removeWorkspace, activeNav, agents, codexEnvironment, contextAgentId, contextBarState, contextResult, createAgent, deleteAgent, duplicateAgent, environmentError, environmentStatus, mcps, notify, patchAgent, refreshCodexEnvironment, runs, selectedAgentId, settings, skills, studioExpanded, updateAgent, updateSettings, upsertRun, workspaces]);

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useLatch() {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useLatch must be used inside LatchProvider");
  return store;
}
