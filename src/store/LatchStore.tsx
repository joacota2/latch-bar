import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import type { AppSettings, CodexAgent, CodexEnvironment, CodexSkill, ContextBarState, McpServer, NavKey, Run, Workspace } from "../domain";
import { DEFAULT_AGENTS_VERSION, seedAgents, seedRuns, seedSettings } from "../data/seed";
import { isTauri, scanCodexEnvironment } from "../services/runtime";

interface Toast { id: number; message: string }

interface LatchState {
  activeNav: NavKey;
  setActiveNav: (nav: NavKey) => void;
  agents: CodexAgent[];
  selectedAgentId: string | null;
  setSelectedAgentId: (id: string | null) => void;
  createAgent: (workspacePath?: string) => string;
  updateAgent: (agent: CodexAgent) => void;
  duplicateAgent: (id: string) => void;
  deleteAgent: (id: string) => void;
  togglePin: (id: string) => void;
  toggleEnabled: (id: string) => void;
  mcps: McpServer[];
  skills: CodexSkill[];
  workspaces: Workspace[];
  addWorkspace: (path: string) => void;
  removeWorkspace: (path: string) => void;
  codexEnvironment: CodexEnvironment | null;
  environmentStatus: "idle" | "loading" | "ready" | "unavailable" | "error";
  environmentError: string;
  refreshCodexEnvironment: (workspacePath?: string, profile?: string) => Promise<CodexEnvironment | null>;
  runs: Run[];
  upsertRun: (run: Run) => void;
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
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
const STORAGE_KEY = "latch-bar-state-v1";
const STATE_EVENT = "latch-state-changed";

interface PersistedState {
  defaultAgentsVersion?: number;
  agents?: CodexAgent[];
  runs?: Run[];
  settings?: AppSettings;
  savedWorkspaces?: Workspace[];
}

function normalizePersisted(parsed: PersistedState | null) {
  if (!parsed) return null;
  const legacySeedIds = new Set(["run-security", "run-writing", "run-error", "run-plan"]);
  let agents = parsed.agents?.map((agent) => {
    const current = { ...agent } as Omit<CodexAgent, "outputPolicy"> & {
      outputPolicy?: Partial<CodexAgent["outputPolicy"]>;
      speed?: string;
    };
    delete current.speed;
    const defaultOutputPolicy = seedAgents.find((seed) => seed.id === current.id)?.outputPolicy ?? seedAgents[0].outputPolicy;
    const mode = current.outputPolicy?.mode ?? defaultOutputPolicy.mode;
    return {
      ...current,
      model: current.model === "custom" ? "default" : current.model,
      serviceTier: current.serviceTier ?? "default",
      outputPolicy: {
        ...defaultOutputPolicy,
        ...current.outputPolicy,
        mode,
        allowReplace: current.outputPolicy?.allowReplace ?? (current.outputPolicy?.mode ? mode !== "open-studio" : defaultOutputPolicy.allowReplace),
      },
    } satisfies CodexAgent;
  });
  if (agents && (parsed.defaultAgentsVersion ?? 0) < DEFAULT_AGENTS_VERSION) {
    // Retire built-in IDs only; user-created agents and duplicates keep their own IDs.
    const retiredIds = new Set(["staff-engineer", "ui-reviewer", "explain-error", "plan-implementation"]);
    agents = agents.filter((agent) => !retiredIds.has(agent.id));
    const addedIds = new Set(["summarize", "explain-simply", "draft-reply"]);
    const existingIds = new Set(agents.map((agent) => agent.id));
    let nextOrder = agents.reduce((max, agent) => Math.max(max, agent.order), -1) + 1;
    const additions = seedAgents.filter((agent) => addedIds.has(agent.id) && !existingIds.has(agent.id));
    agents = [...agents, ...additions.map((agent) => ({ ...agent, order: nextOrder++ }))];
  }
  const settings = parsed.settings
    ? { ...seedSettings, ...parsed.settings } as AppSettings & { codexHome?: string; studioAppearance?: string; contextBarAppearance?: string }
    : undefined;
  if (settings) {
    delete settings.codexHome;
    delete settings.studioAppearance;
    delete settings.contextBarAppearance;
  }
  return {
    ...parsed,
    defaultAgentsVersion: Math.max(parsed.defaultAgentsVersion ?? 0, DEFAULT_AGENTS_VERSION),
    agents,
    settings,
    runs: parsed.settings?.storeHistory === false ? [] : parsed.runs?.filter((run) => !legacySeedIds.has(run.id) && run.sourceApplication !== "Selection preview" && !run.threadId?.startsWith("thr_preview_")),
  };
}

function readPersisted() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return normalizePersisted(JSON.parse(raw) as PersistedState);
  } catch {
    return null;
  }
}

export function LatchProvider({ children }: { children: ReactNode }) {
  const persisted = useMemo(readPersisted, []);
  const [activeNav, setActiveNav] = useState<NavKey>("agents");
  const [agents, setAgents] = useState<CodexAgent[]>(persisted?.agents ?? seedAgents);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[]>(persisted?.runs ?? seedRuns);
  const [mcps, setMcps] = useState<McpServer[]>([]);
  const [skills, setSkills] = useState<CodexSkill[]>([]);
  const [discoveredWorkspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [savedWorkspaces, setSavedWorkspaces] = useState<Workspace[]>(persisted?.savedWorkspaces ?? []);
  const workspaces = useMemo(() => [...savedWorkspaces, ...discoveredWorkspaces.filter((item) => !savedWorkspaces.some((saved) => saved.path === item.path))], [savedWorkspaces, discoveredWorkspaces]);
  const [codexEnvironment, setCodexEnvironment] = useState<CodexEnvironment | null>(null);
  const [environmentStatus, setEnvironmentStatus] = useState<LatchState["environmentStatus"]>("idle");
  const [environmentError, setEnvironmentError] = useState("");
  const [settings, setSettings] = useState<AppSettings>(persisted?.settings ?? seedSettings);
  const [contextBarState, setContextBarState] = useState<ContextBarState>("idle");
  const [contextAgentId, setContextAgentId] = useState<string | null>(null);
  const [contextResult, setContextResult] = useState("");
  const [studioExpanded, setStudioExpanded] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const environmentRequestId = useRef(0);

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

  useEffect(() => {
    const applySnapshot = (snapshot: PersistedState) => {
      const next = normalizePersisted(snapshot);
      if (!next) return;
      if (next.agents) setAgents(next.agents);
      if (next.runs) setRuns(next.runs);
      if (next.settings) setSettings(next.settings);
      if (next.savedWorkspaces) setSavedWorkspaces(next.savedWorkspaces);
    };
    const syncWindowState = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      try {
        applySnapshot(JSON.parse(event.newValue) as PersistedState);
      } catch {
        // Ignore partial writes from an interrupted window shutdown.
      }
    };
    window.addEventListener("storage", syncWindowState);
    const unlisten = isTauri()
      ? listen<PersistedState>(STATE_EVENT, () => { const latest = readPersisted(); if (latest) applySnapshot(latest); })
      : null;
    return () => {
      window.removeEventListener("storage", syncWindowState);
      if (unlisten) void unlisten.then((dispose) => dispose());
    };
  }, []);

  const commit = useCallback((change: (current: Required<PersistedState>) => Required<PersistedState>) => {
    const latest = readPersisted();
    const next = change({ defaultAgentsVersion: latest?.defaultAgentsVersion ?? DEFAULT_AGENTS_VERSION, agents: latest?.agents ?? seedAgents, runs: latest?.runs ?? [], settings: latest?.settings ?? seedSettings, savedWorkspaces: latest?.savedWorkspaces ?? [] });
    next.runs = next.settings.storeHistory ? next.runs.slice(0, 200).map((run) => ({
      ...run,
      conversation: next.settings.storeSelectedText ? run.conversation : run.conversation?.filter((message) => message.id !== "selected-text"),
    })) : [];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setAgents(next.agents);
    setRuns(next.runs);
    setSettings(next.settings);
    setSavedWorkspaces(next.savedWorkspaces);
    if (isTauri()) void emit(STATE_EVENT, next).catch(() => undefined);
  }, []);

  const notify = useCallback((message: string) => {
    const id = Date.now();
    setToasts((items) => [...items, { id, message }]);
    window.setTimeout(() => setToasts((items) => items.filter((item) => item.id !== id)), 2600);
  }, []);

  const updateAgent = useCallback((agent: CodexAgent) => {
    commit((current) => ({ ...current, agents: current.agents.map((item) => item.id === agent.id ? { ...agent, updatedAt: new Date().toISOString() } : item) }));
  }, [commit]);

  const createAgent = useCallback((workspacePath?: string) => {
    const id = `agent-${crypto.randomUUID()}`;
    commit((current) => ({ ...current, agents: [...current.agents, {
      ...seedAgents[0], id, name: "Untitled agent", description: "Describe what this Codex profile should do.", icon: "✦", pinned: false,
      order: current.agents.length, workspaceMode: workspacePath ? "fixed" : "none", fixedWorkspacePath: workspacePath, enabledMcpServers: [], enabledSkills: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }] }));
    setSelectedAgentId(id);
    return id;
  }, [commit]);

  const duplicateAgent = useCallback((id: string) => {
    commit((current) => {
      const source = current.agents.find((item) => item.id === id);
      return source ? { ...current, agents: [...current.agents, { ...source, id: crypto.randomUUID(), name: `${source.name} copy`, pinned: false, order: current.agents.length, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] } : current;
    });
    notify("Agent duplicated");
  }, [commit, notify]);

  const deleteAgent = useCallback((id: string) => {
    commit((current) => ({ ...current, agents: current.agents.filter((item) => item.id !== id) }));
    setSelectedAgentId(null);
    notify("Agent removed");
  }, [commit, notify]);

  const patchAgent = useCallback((id: string, field: "pinned" | "enabled") => {
    commit((current) => ({ ...current, agents: current.agents.map((item) => item.id === id ? { ...item, [field]: !item[field], updatedAt: new Date().toISOString() } : item) }));
  }, [commit]);

  const upsertRun = useCallback((run: Run) => {
    commit((current) => ({ ...current, runs: [run, ...current.runs.filter((item) => item.id !== run.id)] }));
  }, [commit]);

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    commit((current) => ({ ...current, settings: { ...current.settings, ...patch } }));
  }, [commit]);

  const addWorkspace = useCallback((path: string) => {
    const normalized = path.replace(/\/+$/, "") || "/";
    commit((current) => ({ ...current, savedWorkspaces: [{ saved: true, id: normalized, path: normalized, name: normalized.split("/").pop() || normalized, branch: "—", lastUsed: "Saved", color: "#c8f46a" }, ...current.savedWorkspaces.filter((item) => item.path !== normalized)] }));
  }, [commit]);
  const removeWorkspace = useCallback((path: string) => {
    commit((current) => ({ ...current, savedWorkspaces: current.savedWorkspaces.filter((item) => item.path !== path) }));
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
    toasts, notify,
  }), [addWorkspace, removeWorkspace, activeNav, agents, codexEnvironment, contextAgentId, contextBarState, contextResult, createAgent, deleteAgent, duplicateAgent, environmentError, environmentStatus, mcps, notify, patchAgent, refreshCodexEnvironment, runs, selectedAgentId, settings, skills, studioExpanded, updateAgent, updateSettings, upsertRun, workspaces]);

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useLatch() {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useLatch must be used inside LatchProvider");
  return store;
}
