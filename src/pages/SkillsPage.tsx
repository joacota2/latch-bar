import { Braces, Check, Search, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { PageIntro, SourceTag, Toggle } from "../components/ui";
import { useLatch } from "../store/LatchStore";

export function SkillsPage() {
  const { skills, notify } = useLatch();
  const [query, setQuery] = useState("");
  const visible = useMemo(() => skills.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase())), [query, skills]);
  return <div className="page catalog-page">
    <PageIntro eyebrow="DISCOVERED AUTOMATICALLY" title="Skills Codex already knows" description="Latch discovers global, project, plugin, and managed Skills without creating a second skill system." action={<label className="inline-search"><Search size={15} /><input aria-label="Search skills" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a skill…" /></label>} />
    <div className="skills-list">
      {visible.map((skill) => <article className="skill-row" key={skill.id}>
        <span className="skill-icon"><Braces size={18} /></span>
        <div className="skill-copy"><h3>{skill.name}</h3><p>{skill.description}</p><div><SourceTag>{skill.source}</SourceTag>{skill.pluginId && <SourceTag>Plugin: {skill.pluginId}</SourceTag>}{skill.compatible && <span className="compatible"><Check size={11} /> Compatible</span>}</div></div>
        <div className="skill-agents"><span>Used by</span><div>{skill.id === "testing" ? <><b>⌘</b><b>↗</b></> : skill.id === "technical-writing" ? <b>✦</b> : <b>⌘</b>}</div></div>
        <Toggle checked={skill.enabled} onChange={() => notify("Skill availability follows Codex configuration")} label={`Enable ${skill.name}`} />
      </article>)}
    </div>
    <div className="info-banner"><ShieldCheck size={19} /><div><strong>Explicit by default</strong><p>New agents start with no Skills selected. A profile can only load the Skills you assign to it.</p></div></div>
  </div>;
}
