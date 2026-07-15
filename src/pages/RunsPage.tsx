import { Check, ChevronRight, CircleAlert, Clock3, Copy, Filter, LoaderCircle, ShieldAlert, Square } from "lucide-react";
import { useMemo, useState } from "react";
import { AgentGlyph, SectionLabel } from "../components/ui";
import type { Run, RunStatus } from "../domain";
import { useLatch } from "../store/LatchStore";

const statusMeta: Record<RunStatus, { label: string; icon: typeof Check }> = {
  running: { label: "Running", icon: LoaderCircle },
  approval: { label: "Needs approval", icon: ShieldAlert },
  completed: { label: "Completed", icon: Check },
  failed: { label: "Failed", icon: CircleAlert },
  cancelled: { label: "Cancelled", icon: Square },
};

function RunRow({ run, onSelect }: { run: Run; onSelect: () => void }) {
  const meta = statusMeta[run.status];
  const Icon = meta.icon;
  return <button className="run-row" onClick={onSelect}>
    <AgentGlyph agent={{ icon: run.agentIcon, accent: run.agentId === "staff-engineer" ? "purple" : run.agentId === "improve-writing" ? "lime" : "blue" }} />
    <div className="run-main"><strong>{run.agentName}</strong><span><b className="app-token">{run.sourceIcon}</b>{run.sourceApplication}{run.workspacePath && <> · {run.workspacePath.split("/").at(-1)}</>}</span></div>
    <div className="run-activity"><span className={`run-status ${run.status}`}><Icon size={13} />{meta.label}</span><small>{run.activity}</small></div>
    <div className="run-time"><span>{run.startedAt}</span><small>{run.duration ?? run.model}</small></div>
    <ChevronRight size={16} />
  </button>;
}

export function RunsPage() {
  const { runs, upsertRun, notify } = useLatch();
  const [filter, setFilter] = useState<"all" | RunStatus>("all");
  const [selected, setSelected] = useState<Run | null>(null);
  const visible = useMemo(() => filter === "all" ? runs : runs.filter((run) => run.status === filter), [filter, runs]);
  const active = visible.filter((run) => run.status === "running" || run.status === "approval");
  const history = visible.filter((run) => run.status !== "running" && run.status !== "approval");
  const approve = (run: Run) => {
    const next = { ...run, status: "running" as const, activity: "Running npm test…" };
    upsertRun(next); setSelected(next); notify("Command allowed once");
    window.setTimeout(() => { const done = { ...next, status: "completed" as const, activity: "Tests passed", duration: "12.4s", finalResponse: "All 48 tests passed. No regressions found in the selected change." }; upsertRun(done); setSelected(done); }, 1400);
  };
  return <div className="page runs-page">
    <div className="runs-summary">
      <div><span className="metric-icon running"><LoaderCircle size={18} /></span><strong>{runs.filter((run) => run.status === "running").length}</strong><small>Running now</small></div>
      <div><span className="metric-icon approval"><ShieldAlert size={18} /></span><strong>{runs.filter((run) => run.status === "approval").length}</strong><small>Needs approval</small></div>
      <div><span className="metric-icon complete"><Check size={18} /></span><strong>{runs.filter((run) => run.status === "completed").length}</strong><small>Completed</small></div>
      <div><span className="metric-icon time"><Clock3 size={18} /></span><strong>6.1s</strong><small>Average duration</small></div>
    </div>
    <div className="filter-bar"><Filter size={15} /><span>Show</span>{(["all", "running", "approval", "completed", "failed"] as const).map((item) => <button className={filter === item ? "active" : ""} onClick={() => setFilter(item)} key={item}>{item === "approval" ? "Needs approval" : item[0].toUpperCase() + item.slice(1)}</button>)}</div>
    {active.length > 0 && <section className="content-section"><SectionLabel>In progress</SectionLabel><div className="runs-list">{active.map((run) => <RunRow key={run.id} run={run} onSelect={() => setSelected(run)} />)}</div></section>}
    <section className="content-section"><SectionLabel>History</SectionLabel><div className="runs-list">{history.map((run) => <RunRow key={run.id} run={run} onSelect={() => setSelected(run)} />)}</div></section>
    {selected && <div className="detail-scrim" onClick={() => setSelected(null)}><aside className="run-detail" onClick={(event) => event.stopPropagation()}><div className="drawer-header"><div><span className={`run-status ${selected.status}`}>{statusMeta[selected.status].label}</span><h2>{selected.agentName}</h2><p>{selected.sourceApplication} · {selected.startedAt}</p></div><button className="drawer-close" onClick={() => setSelected(null)}>×</button></div><div className="run-detail-body"><div className="detail-grid"><div><span>Model</span><strong>{selected.model}</strong></div><div><span>Sandbox</span><strong>{selected.sandbox}</strong></div><div><span>Thread</span><strong>{selected.threadId ?? "—"}</strong></div><div><span>Duration</span><strong>{selected.duration ?? "In progress"}</strong></div></div>{selected.status === "approval" && <div className="approval-card"><ShieldAlert size={20} /><div><h3>Codex requests permission</h3><p>Run this command in <code>{selected.workspacePath}</code></p><pre>{selected.command}</pre><div><button className="primary-button" onClick={() => approve(selected)}>Allow once</button><button className="secondary-button" onClick={() => { upsertRun({ ...selected, status: "cancelled", activity: "Permission denied" }); setSelected(null); }}>Deny</button></div></div></div>}{selected.finalResponse && <div className="result-card"><div><h3>Result</h3><button onClick={() => { navigator.clipboard?.writeText(selected.finalResponse!); notify("Result copied"); }}><Copy size={14} /> Copy</button></div><p>{selected.finalResponse}</p></div>}<div className="event-log"><h3>Activity</h3><div><i className="done" /><span>Selection received</span><small>{selected.startedAt}</small></div><div><i className="done" /><span>Codex thread created</span><small>{selected.threadId ?? "local"}</small></div><div><i className={selected.status === "failed" ? "error" : "done"} /><span>{selected.activity}</span><small>{selected.duration ?? "now"}</small></div></div></div></aside></div>}
  </div>;
}
