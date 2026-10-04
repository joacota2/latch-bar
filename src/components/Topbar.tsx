import { CircleHelp, Search, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { NavKey } from "../domain";
import { getPlatformStatus, requestAccessibilityPermission } from "../services/runtime";
import { useLatch } from "../store/LatchStore";

const labels: Record<NavKey, [string, string]> = {
  agents: ["Agents", "Create specialized agents for any context."],
  runs: ["Runs", "See what your agents are doing and what needs your attention."],
  mcps: ["MCP servers", "Connected tools available to your agents."],
  skills: ["Skills", "Reusable workflows available to your agents."],
  workspaces: ["Workspaces", "Projects Latch can connect to selected context."],
  settings: ["Settings", "Control your integrations, selection behavior, and privacy."],
};

interface SearchEntry {
  id: string;
  title: string;
  description: string;
  nav: NavKey;
  agentId?: string;
}

export function Topbar() {
  const {
    helpRequest,
    activeNav,
    agents,
    mcps,
    notify,
    runs,
    setActiveNav,
    setSelectedAgentId,
    settings,
    skills,
    updateSettings,
    workspaces,
  } = useLatch();
  const [searchOpen, setSearchOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  useEffect(() => { if (helpRequest) { setHelpOpen(true); setSearchOpen(false); } }, [helpRequest]);
  const [query, setQuery] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);

  const entries = useMemo<SearchEntry[]>(() => [
    ...Object.entries(labels).map(([nav, [title, description]]) => ({ id: `nav-${nav}`, title, description, nav: nav as NavKey })),
    ...agents.map((agent) => ({ id: `agent-${agent.id}`, title: agent.name, description: agent.description, nav: "agents" as const, agentId: agent.id })),
    ...runs.map((run) => ({ id: `run-${run.id}`, title: run.agentName, description: `${run.status} · ${run.activity}`, nav: "runs" as const })),
    ...mcps.map((mcp) => ({ id: `mcp-${mcp.id}`, title: mcp.name, description: mcp.detail, nav: "mcps" as const })),
    ...skills.map((skill) => ({ id: `skill-${skill.id}`, title: skill.name, description: skill.description, nav: "skills" as const })),
    ...workspaces.map((workspace) => ({ id: `workspace-${workspace.id}`, title: workspace.name, description: workspace.path, nav: "workspaces" as const })),
  ], [agents, mcps, runs, skills, workspaces]);

  const results = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return entries.slice(0, 8);
    return entries.filter((entry) => `${entry.title} ${entry.description}`.toLocaleLowerCase().includes(normalized)).slice(0, 12);
  }, [entries, query]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        setHelpOpen(false);
        setSearchOpen((open) => !open);
      }
      if (event.key === "Escape") {
        setSearchOpen(false);
        setHelpOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (searchOpen) window.setTimeout(() => searchInput.current?.focus(), 0);
    else setQuery("");
  }, [searchOpen]);

  const selectEntry = (entry: SearchEntry) => {
    setActiveNav(entry.nav);
    setSelectedAgentId(entry.agentId ?? null);
    setSearchOpen(false);
  };

  const toggleContextBar = async () => {
    const enabled = !settings.contextBarEnabled;
    if (!await updateSettings({ contextBarEnabled: enabled })) return;
    if (!enabled) {
      notify("Context Bar paused");
      return;
    }
    try {
      const status = await getPlatformStatus();
      if (!status.supported) {
        notify("Context Bar selection requires the Latch Bar desktop app");
      } else if (!status.accessibilityTrusted) {
        await requestAccessibilityPermission();
        notify("Allow Latch Bar in Accessibility. No restart is needed after approval.");
      } else {
        notify("Context Bar enabled");
      }
    } catch {
      notify("Could not check Accessibility permission");
    }
  };

  return (
    <>
      <header className="topbar">
        <div className="topbar-copy"><h1>{labels[activeNav][0]}</h1><p>{labels[activeNav][1]}</p></div>
        <div className="topbar-actions">
          <button className="search-button" onClick={() => { setHelpOpen(false); setSearchOpen(true); }}><Search size={16} /><span>Search</span><kbd>⌘ K</kbd></button>
          <button className="icon-button" aria-label="Help" onClick={() => { setSearchOpen(false); setHelpOpen(true); }}><CircleHelp size={18} /></button>
          <button className={settings.contextBarEnabled ? "bar-status on" : "bar-status"} aria-pressed={settings.contextBarEnabled} onClick={() => void toggleContextBar()}>
            <Sparkles size={15} /><span>Context Bar</span><i />
          </button>
        </div>
      </header>

      {searchOpen && (
        <div className="dialog-scrim" onMouseDown={() => setSearchOpen(false)}>
          <section className="search-dialog" role="dialog" aria-modal="true" aria-label="Search Latch" onMouseDown={(event) => event.stopPropagation()}>
            <header><Search size={17} /><input ref={searchInput} aria-label="Search Latch" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && results[0]) selectEntry(results[0]); }} placeholder="Search agents, runs, MCPs, skills, and workspaces…" /><button aria-label="Close search" onClick={() => setSearchOpen(false)}><X size={16} /></button></header>
            <div className="search-results" aria-live="polite">
              {results.length > 0 ? results.map((entry) => (
                <button key={entry.id} onClick={() => selectEntry(entry)}>
                  <span><strong>{entry.title}</strong><small>{entry.description}</small></span>
                  <em>{labels[entry.nav][0]}</em>
                </button>
              )) : <p>No results for “{query}”.</p>}
            </div>
            <footer><span><kbd>↵</kbd> Open a result</span><span><kbd>esc</kbd> Close</span></footer>
          </section>
        </div>
      )}

      {helpOpen && (
        <div className="dialog-scrim" onMouseDown={() => setHelpOpen(false)}>
          <section className="help-dialog" role="dialog" aria-modal="true" aria-labelledby="help-title" onMouseDown={(event) => event.stopPropagation()}>
            <header><div><span className="eyebrow">QUICK START</span><h2 id="help-title">Using Latch Bar</h2></div><button aria-label="Close help" onClick={() => setHelpOpen(false)}><X size={17} /></button></header>
            <ol>
              <li><b>1</b><span><strong>Allow Accessibility</strong><small>Open Settings → Selection and grant access when macOS asks. Latch detects approval without a restart.</small></span></li>
              <li><b>2</b><span><strong>Select at least {settings.minimumCharacters} characters</strong><small>The Context Bar appears beside the selection after {settings.selectionDelay} ms.</small></span></li>
              <li><b>3</b><span><strong>Choose an agent</strong><small>Latch sends the selected text only after you choose the profile that should process it.</small></span></li>
            </ol>
            <div className="help-shortcuts"><span><kbd>⌥ Space</kbd><small>Open Studio anywhere</small></span><span><kbd>⌘ K</kbd><small>Search Studio</small></span></div>
            <footer><button className="primary-button" onClick={() => { setActiveNav("settings"); setHelpOpen(false); }}>Open Settings</button></footer>
          </section>
        </div>
      )}
    </>
  );
}
