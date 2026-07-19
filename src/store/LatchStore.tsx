import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import type { AppSettings, CodexAgent, CodexEnvironment, CodexSkill, ContextBarState, McpServer, NavKey, Run, Workspace } from "../domain";
import { seedAgents, seedRuns, seedSettings } from "../data/seed";
import { isTauri, scanCodexEnvironment } from "../services/runtime";

interface Toast { id: number; message: string }

interface LatchState {
  activeNav: NavKey;
  setActiveNav: (nav: NavKey) => void;
  agents: CodexAgent[];
  selectedAgentId: string | null;
  setSelectedAgentId: (id: string | null) => void;
  createAgent: () => string;
  updateAgent: (agent: CodexAgent) => void;
  duplicateAgent: (id: string) => void;
  deleteAgent: (id: string) => void;
  togglePin: (id: string) => void;
  toggleEnabled: (id: string) => void;
  mcps: McpServer[];
  skills: CodexSkill[];
  workspaces: Workspace[];
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
  agents?: CodexAgent[];
  runs?: Run[];
  settings?: AppSettings;
}

function normalizePersisted(parsed: PersistedState | null) {
  if (!parsed) return null;
  const legacySeedIds = new Set(["run-security", "run-writing", "run-error", "run-plan"]);
  const agents = parsed.agents?.map((agent) => {
    const current = { ...agent } as CodexAgent & { speed?: string };
    delete current.speed;
    return {
      ...current,
      model: current.model === "custom" ? "default" : current.model,
      serviceTier: current.serviceTier ?? "default",
    } satisfies CodexAgent;
  });
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
    agents,
    settings,
    runs: parsed.runs?.filter((run) => !legacySeedIds.has(run.id) && run.sourceApplication !== "Selection preview" && !run.threadId?.startsWith("thr_preview_")),
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
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
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
      ? listen<PersistedState>(STATE_EVENT, ({ payload }) => applySnapshot(payload))
      : null;
    return () => {
      window.removeEventListener("storage", syncWindowState);
      if (unlisten) void unlisten.then((dispose) => dispose());
    };
  }, []);

  const persist = useCallback((nextAgents: CodexAgent[], nextRuns: Run[], nextSettings: AppSettings) => {
    const snapshot = { agents: nextAgents, runs: nextRuns, settings: nextSettings };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    if (isTauri()) void emit(STATE_EVENT, snapshot).catch(() => undefined);
  }, []);

  const notify = useCallback((message: string) => {
    const id = Date.now();
    setToasts((items) => [...items, { id, message }]);
    window.setTimeout(() => setToasts((items) => items.filter((item) => item.id !== id)), 2600);
  }, []);

  const updateAgent = useCallback((agent: CodexAgent) => {
    setAgents((current) => {
      const next = current.map((item) => item.id === agent.id ? { ...agent, updatedAt: new Date().toISOString() } : item);
      persist(next, runs, settings);
      return next;
    });
  }, [persist, runs, settings]);

  const createAgent = useCallback(() => {
    const id = `agent-${Date.now()}`;
    const nextAgent: CodexAgent = {
      ...seedAgents[0],
      id,
      name: "Untitled agent",
      description: "Describe what this Codex profile should do.",
      icon: "✦",
      pinned: false,
      order: agents.length,
      enabledMcpServers: [],
      enabledSkills: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const next = [...agents, nextAgent];
    setAgents(next);
    persist(next, runs, settings);
    setSelectedAgentId(id);
    return id;
  }, [agents, persist, runs, settings]);

  const duplicateAgent = useCallback((id: string) => {
    const source = agents.find((agent) => agent.id === id);
    if (!source) return;
    const copy = { ...source, id: `${source.id}-copy-${Date.now()}`, name: `${source.name} copy`, pinned: false, order: agents.length, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const next = [...agents, copy];
    setAgents(next);
    persist(next, runs, settings);
    notify("Agent duplicated");
  }, [agents, notify, persist, runs, settings]);

  const deleteAgent = useCallback((id: string) => {
    const next = agents.filter((agent) => agent.id !== id);
    setAgents(next);
    persist(next, runs, settings);
    setSelectedAgentId(null);
    notify("Agent removed");
  }, [agents, notify, persist, runs, settings]);

  const patchAgent = useCallback((id: string, patch: Partial<CodexAgent>) => {
    const next = agents.map((agent) => agent.id === id ? { ...agent, ...patch, updatedAt: new Date().toISOString() } : agent);
    setAgents(next);
    persist(next, runs, settings);
  }, [agents, persist, runs, settings]);

  const upsertRun = useCallback((run: Run) => {
    setRuns((current) => {
      const next = [run, ...current.filter((item) => item.id !== run.id)];
      persist(agents, next, settings);
      return next;
    });
  }, [agents, persist, settings]);

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    persist(agents, runs, next);
  }, [agents, persist, runs, settings]);

  const value = useMemo<LatchState>(() => ({
    activeNav, setActiveNav,
    agents, selectedAgentId, setSelectedAgentId, createAgent, updateAgent, duplicateAgent, deleteAgent,
    togglePin: (id) => patchAgent(id, { pinned: !agents.find((agent) => agent.id === id)?.pinned }),
    toggleEnabled: (id) => patchAgent(id, { enabled: !agents.find((agent) => agent.id === id)?.enabled }),
    mcps, skills, workspaces,
    codexEnvironment, environmentStatus, environmentError, refreshCodexEnvironment,
    runs, upsertRun,
    settings, updateSettings,
    contextBarState, setContextBarState, contextAgentId, setContextAgentId, contextResult, setContextResult,
    studioExpanded, setStudioExpanded,
    toasts, notify,
  }), [activeNav, agents, codexEnvironment, contextAgentId, contextBarState, contextResult, createAgent, deleteAgent, duplicateAgent, environmentError, environmentStatus, mcps, notify, patchAgent, refreshCodexEnvironment, runs, selectedAgentId, settings, skills, studioExpanded, updateAgent, updateSettings, upsertRun, workspaces]);

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useLatch() {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useLatch must be used inside LatchProvider");
  return store;
}
