import { Braces, Check, Search, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { PageIntro, SourceTag, Toggle } from "../components/ui";
import { useLatch } from "../store/LatchStore";

export function SkillsPage() {
  const { agents, skills, environmentStatus, notify } = useLatch();
  const [query, setQuery] = useState("");
  const visible = useMemo(() => skills.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase())), [query, skills]);
  return <div className="page catalog-page">
    <PageIntro eyebrow="SKILLS" title="Workflows for your agents" description="Names, scopes, availability, and paths come from Codex's effective Skill resolver." action={<label className="inline-search"><Search size={15} /><input aria-label="Search skills" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a skill…" /></label>} />
    <div className="skills-list">
      {visible.map((skill) => { const users = agents.filter((agent) => agent.enabledSkills.includes(skill.id)); return <article className="skill-row" key={skill.id}>
        <span className="skill-icon"><Braces size={18} /></span>
        <div className="skill-copy"><h3>{skill.name}</h3><p>{skill.description}</p><div><SourceTag>{skill.source}</SourceTag>{skill.compatible && <span className="compatible"><Check size={11} /> Available</span>}</div></div>
        <div className="skill-agents"><span>Used by</span><div>{users.length > 0 ? users.slice(0, 4).map((agent) => <b title={agent.name} key={agent.id}>{agent.icon}</b>) : <small>None</small>}</div></div>
        <Toggle disabled checked={skill.enabled} onChange={() => notify("Skill availability follows Codex configuration")} label={`Enable ${skill.name}`} />
      </article>; })}
      {visible.length === 0 && <div className="info-banner"><Braces size={19} /><div><strong>{environmentStatus === "loading" ? "Loading Skills" : "No Skills reported"}</strong><p>{environmentStatus === "loading" ? "Codex is resolving Skills for the current workspace." : "Codex app-server did not return a matching enabled Skill."}</p></div></div>}
    </div>
    <div className="info-banner"><ShieldCheck size={19} /><div><strong>Explicit by default</strong><p>New agents start with no Skills selected. Assigned Skills are explicitly attached to the run. Codex may also discover Skills under its own configuration.</p></div></div>
  </div>;
}
