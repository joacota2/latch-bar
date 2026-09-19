import { ArrowRight, Copy, MoreHorizontal, Pin, Play, Plus, ShieldCheck, Sparkles } from "lucide-react";
import { useState } from "react";
import { AgentGlyph, SectionLabel, Toggle } from "../components/ui";
import type { CodexAgent } from "../domain";
import { useLatch } from "../store/LatchStore";

function AgentCard({ agent }: { agent: CodexAgent }) {
  const { setSelectedAgentId } = useLatch();
  return (
    <button className="agent-card" onClick={() => setSelectedAgentId(agent.id)}>
      <div className="agent-card-top"><AgentGlyph agent={agent} size="lg" /><span className="mini-pin"><Pin size={12} fill="currentColor" /></span></div>
      <div className="agent-card-copy"><h4>{agent.name}</h4><p>{agent.description}</p></div>
      <div className="agent-card-footer"><span>{agent.sandbox === "read-only" ? "No computer access" : agent.workspaceMode === "ask-each-time" ? "Choose workspace" : "Workspace access"}</span><span className="round-play"><Play size={13} fill="currentColor" /></span></div>
    </button>
  );
}

function AgentRow({ agent }: { agent: CodexAgent }) {
  const { setSelectedAgentId, toggleEnabled, togglePin, duplicateAgent } = useLatch();
  const [open, setOpen] = useState(false);
  return (
    <div className="agent-row" onClick={() => setSelectedAgentId(agent.id)}>
      <AgentGlyph agent={agent} />
      <div className="agent-row-copy"><strong>{agent.name}</strong><span>{agent.description}</span></div>
      <div className="agent-runtime"><span>{agent.model === "default" ? "Codex default" : agent.model}</span><small>{agent.reasoningEffort} reasoning</small></div>
      <span className={`access-chip ${agent.sandbox}`}>{agent.sandbox === "read-only" ? "Read only" : agent.sandbox === "workspace-write" ? "Workspace write" : "Full access"}</span>
      <button className={agent.pinned ? "pin-button pinned" : "pin-button"} onClick={(event) => { event.stopPropagation(); togglePin(agent.id); }} aria-label={`Pin ${agent.name}`}><Pin size={15} fill={agent.pinned ? "currentColor" : "none"} /></button>
      <span onClick={(event) => event.stopPropagation()}><Toggle checked={agent.enabled} onChange={() => toggleEnabled(agent.id)} label={`Enable ${agent.name}`} /></span>
      <div className="row-menu-wrap">
        <button className="ghost-icon" onClick={(event) => { event.stopPropagation(); setOpen(!open); }} aria-label="Agent actions"><MoreHorizontal size={18} /></button>
        {open && <div className="row-menu" onClick={(event) => event.stopPropagation()}><button onClick={() => setSelectedAgentId(agent.id)}>Edit agent</button><button onClick={() => duplicateAgent(agent.id)}><Copy size={13} /> Duplicate</button></div>}
      </div>
    </div>
  );
}

export function AgentsPage() {
  const { agents, createAgent, settings } = useLatch();
  const pinned = agents.filter((agent) => agent.pinned && agent.enabled).sort((a, b) => a.order - b.order);
  return (
    <div className="page agents-page">
      <section className="hero-banner">
        <div className="hero-icon"><Sparkles size={22} /></div>
        <div><span className="eyebrow">YOUR CODEX, EVERYWHERE</span><h2>One selection. The right expert.</h2><p>Highlight text in any app and your favorite Codex profiles appear right beside it.</p></div>
        <div className="hero-preview" aria-label="Context bar preview"><span title="Improve writing" aria-label="Improve writing"><i>✦</i></span><span title="Staff engineer" aria-label="Staff engineer"><i>⌘</i></span><span title="Translate to English" aria-label="Translate to English"><i>EN</i></span><b>···</b></div>
      </section>

      <section className="content-section">
        <SectionLabel meta={<span className={settings.contextBarEnabled ? "live-label" : "live-label off"}><i /> {settings.contextBarEnabled ? "Showing in Context Bar" : "Context Bar paused"}</span>}>Pinned</SectionLabel>
        <div className="agent-card-grid">
          {pinned.map((agent) => <AgentCard agent={agent} key={agent.id} />)}
          <button className="pin-placeholder" onClick={() => createAgent()}><Plus size={19} /><span>Pin another agent</span><small>Extra pins stay available in the picker</small></button>
        </div>
      </section>

      <section className="content-section all-agents-section">
        <SectionLabel meta={<button className="primary-button" onClick={() => createAgent()}><Plus size={16} /> New agent</button>}>All agents <span className="count">{agents.length}</span></SectionLabel>
        <div className="agent-table">
          <div className="agent-table-head"><span>Agent</span><span>Runtime</span><span>Access</span><span>Pin</span><span>Active</span><span /></div>
          {agents.map((agent) => <AgentRow agent={agent} key={agent.id} />)}
        </div>
      </section>

      <section className="privacy-note"><ShieldCheck size={19} /><div><strong>Permission-first by design</strong><p>Each agent gets only the access you choose. Selection content stays local until you run a profile.</p></div><button>Learn how it works <ArrowRight size={14} /></button></section>
    </div>
  );
}
