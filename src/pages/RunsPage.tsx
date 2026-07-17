import { ArrowUpRight, Check, ChevronRight, CircleAlert, Clock3, Copy, Filter, LoaderCircle, ShieldAlert, Square } from "lucide-react";
import { useMemo, useState } from "react";
import { AgentGlyph, SectionLabel } from "../components/ui";
import type { Run, RunStatus } from "../domain";
import { openCodexThread } from "../services/runtime";
import { useLatch } from "../store/LatchStore";

const statusMeta: Record<RunStatus, { label: string; icon: typeof Check }> = {
  running: { label: "Running", icon: LoaderCircle },
  approval: { label: "Needs approval", icon: ShieldAlert },
  completed: { label: "Completed", icon: Check },
  failed: { label: "Failed", icon: CircleAlert },
  cancelled: { label: "Cancelled", icon: Square },
};

function RunRow({ run, onSelect, onOpenCodex }: { run: Run; onSelect: () => void; onOpenCodex: () => void }) {
  const meta = statusMeta[run.status];
  const Icon = meta.icon;
  return <div className="run-row">
    <button className="run-row-select" onClick={onSelect}>
      <AgentGlyph agent={{ icon: run.agentIcon, accent: run.agentId === "staff-engineer" ? "purple" : run.agentId === "improve-writing" ? "lime" : "blue" }} />
      <div className="run-main"><strong>{run.agentName}</strong><span><b className="app-token">{run.sourceIcon}</b>{run.sourceApplication}{run.workspacePath && <> · {run.workspacePath.split("/").at(-1)}</>}</span></div>
      <div className="run-activity"><span className={`run-status ${run.status}`}><Icon size={13} />{meta.label}</span><small>{run.activity}</small></div>
      <div className="run-time"><span>{run.startedAt}</span><small>{run.duration ?? run.model}</small></div>
      <ChevronRight size={16} />
    </button>
    <button className="run-codex-link" disabled={!run.threadId} onClick={onOpenCodex} aria-label={run.threadId ? `Open ${run.agentName} conversation in Codex` : `Codex conversation unavailable for ${run.agentName}`} title={run.threadId ? "Open conversation in Codex" : "Thread ID unavailable"}>
      <ArrowUpRight size={15} />
    </button>
  </div>;
}

export function RunsPage() {
  const { runs, notify } = useLatch();
  const [filter, setFilter] = useState<"all" | RunStatus>("all");
  const [selected, setSelected] = useState<Run | null>(null);
  const visible = useMemo(() => filter === "all" ? runs : runs.filter((run) => run.status === filter), [filter, runs]);
  const active = visible.filter((run) => run.status === "running" || run.status === "approval");
  const history = visible.filter((run) => run.status !== "running" && run.status !== "approval");
  const completedDurations = runs.filter((run) => run.status === "completed" && run.duration).map((run) => Number.parseFloat(run.duration!)).filter(Number.isFinite);
  const averageDuration = completedDurations.length ? `${(completedDurations.reduce((sum, value) => sum + value, 0) / completedDurations.length).toFixed(1)}s` : "—";

  const openInCodex = (run: Run) => {
    if (!run.threadId) return;
    void openCodexThread(run.threadId).catch(() => notify("Could not open this conversation in Codex"));
  };

  const row = (run: Run) => <RunRow key={run.id} run={run} onSelect={() => setSelected(run)} onOpenCodex={() => openInCodex(run)} />;

  return <div className="page runs-page">
    <div className="runs-summary">
      <div><span className="metric-icon running"><LoaderCircle size={18} /></span><strong>{runs.filter((run) => run.status === "running").length}</strong><small>Running now</small></div>
      <div><span className="metric-icon approval"><ShieldAlert size={18} /></span><strong>{runs.filter((run) => run.status === "approval").length}</strong><small>Needs approval</small></div>
      <div><span className="metric-icon complete"><Check size={18} /></span><strong>{runs.filter((run) => run.status === "completed").length}</strong><small>Completed</small></div>
      <div><span className="metric-icon time"><Clock3 size={18} /></span><strong>{averageDuration}</strong><small>Average duration</small></div>
    </div>
    <div className="filter-bar"><Filter size={15} /><span>Show</span>{(["all", "running", "approval", "completed", "failed"] as const).map((item) => <button className={filter === item ? "active" : ""} onClick={() => setFilter(item)} key={item}>{item === "approval" ? "Needs approval" : item[0].toUpperCase() + item.slice(1)}</button>)}</div>
    {active.length > 0 && <section className="content-section"><SectionLabel>In progress</SectionLabel><div className="runs-list">{active.map(row)}</div></section>}
    <section className="content-section"><SectionLabel>History</SectionLabel><div className="runs-list">{history.map(row)}{history.length === 0 && <div className="info-banner"><div><strong>No native runs yet</strong><p>Select text in another application and choose an agent from the Context Bar.</p></div></div>}</div></section>
    {selected && <div className="detail-scrim" onClick={() => setSelected(null)}>
      <aside className="run-detail" onClick={(event) => event.stopPropagation()}>
        <div className="drawer-header">
          <div><span className={`run-status ${selected.status}`}>{statusMeta[selected.status].label}</span><h2>{selected.agentName}</h2><p>{selected.sourceApplication} · {selected.startedAt}</p></div>
          {selected.threadId && <button className="drawer-codex-link" onClick={() => openInCodex(selected)}><ArrowUpRight size={14} /> Open in Codex</button>}
          <button className="drawer-close" onClick={() => setSelected(null)}>×</button>
        </div>
        <div className="run-detail-body">
          <div className="detail-grid"><div><span>Model</span><strong>{selected.model}</strong></div><div><span>Sandbox</span><strong>{selected.sandbox}</strong></div><div><span>Thread</span><strong>{selected.threadId ?? "—"}</strong></div><div><span>Duration</span><strong>{selected.duration ?? "In progress"}</strong></div></div>
          {selected.status === "approval" && <div className="approval-card"><ShieldAlert size={20} /><div><h3>Codex is waiting for permission</h3><p>Respond from the Context Bar beside the original selection.</p></div></div>}
          {selected.finalResponse && <div className="result-card"><div><h3>Result</h3><button onClick={() => { navigator.clipboard?.writeText(selected.finalResponse!); notify("Result copied"); }}><Copy size={14} /> Copy</button></div><p>{selected.finalResponse}</p></div>}
          <div className="event-log"><h3>Activity</h3><div><i className={selected.status === "failed" ? "error" : "done"} /><span>{selected.activity}</span><small>{selected.duration ?? "now"}</small></div></div>
        </div>
      </aside>
    </div>}
  </div>;
}
