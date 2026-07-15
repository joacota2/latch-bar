import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AppSettings, CodexAgent, CodexSkill, ContextBarState, McpServer, NavKey, Run, Workspace } from "../domain";
import { seedAgents, seedMcps, seedRuns, seedSettings, seedSkills, seedWorkspaces } from "../data/seed";
import { scanCodexEnvironment } from "../services/runtime";

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

function readPersisted() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as { agents?: CodexAgent[]; runs?: Run[]; settings?: AppSettings };
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
  const [mcps, setMcps] = useState<McpServer[]>(seedMcps);
  const [skills, setSkills] = useState<CodexSkill[]>(seedSkills);
  const [settings, setSettings] = useState<AppSettings>(persisted?.settings ?? seedSettings);
  const [contextBarState, setContextBarState] = useState<ContextBarState>("idle");
  const [contextAgentId, setContextAgentId] = useState<string | null>(null);
  const [contextResult, setContextResult] = useState("");
  const [studioExpanded, setStudioExpanded] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    void scanCodexEnvironment().then((environment) => {
      if (!environment) return;
      setMcps(environment.mcps);
      setSkills(environment.skills);
    }).catch(() => undefined);
  }, []);

  const persist = useCallback((nextAgents: CodexAgent[], nextRuns: Run[], nextSettings: AppSettings) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ agents: nextAgents, runs: nextRuns, settings: nextSettings }));
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
    mcps, skills, workspaces: seedWorkspaces,
    runs, upsertRun,
    settings, updateSettings,
    contextBarState, setContextBarState, contextAgentId, setContextAgentId, contextResult, setContextResult,
    studioExpanded, setStudioExpanded,
    toasts, notify,
  }), [activeNav, agents, contextAgentId, contextBarState, contextResult, createAgent, deleteAgent, duplicateAgent, mcps, notify, patchAgent, runs, selectedAgentId, settings, skills, studioExpanded, updateAgent, updateSettings, upsertRun]);

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useLatch() {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useLatch must be used inside LatchProvider");
  return store;
}
