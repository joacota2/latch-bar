import { ArrowUpRight, Check, Clipboard, Copy, Ellipsis, LoaderCircle, MessageCircle, Replace, ShieldAlert, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CodexAgent, Run } from "../domain";
import { useLatch } from "../store/LatchStore";

const resultFor = (agent: CodexAgent) => {
  if (agent.id === "improve-writing") return "Clear writing makes the next action obvious while preserving every important detail.";
  if (agent.id === "translate") return "The selected text has been translated into natural English while preserving its tone and structure.";
  if (agent.id === "staff-engineer") return "The highest-risk gap is the missing runtime boundary. Introduce a platform adapter, verify approval events, then add one end-to-end selection test.";
  if (agent.id === "ui-reviewer") return "The hierarchy is clear, but the approval state needs stronger contrast and a persistent indication of the active sandbox.";
  if (agent.id === "explain-error") return "The dependency graph contains two incompatible versions. Align the lockfile, reinstall, and rerun the smallest failing test first.";
  return "Start with the runtime boundary, implement the profile contract, then verify selection → approval → result as one complete slice.";
};

export function ContextBar() {
  const { agents, settings, contextBarState, setContextBarState, contextAgentId, setContextAgentId, contextResult, setContextResult, upsertRun, setStudioExpanded, notify } = useLatch();
  const [approved, setApproved] = useState(false);
  const approvedRef = useRef(false);
  const manualContinuationRef = useRef(false);
  const [allOpen, setAllOpen] = useState(false);
  const timer = useRef<number | null>(null);
  const manualTimer = useRef<number | null>(null);
  const agent = agents.find((item) => item.id === contextAgentId) ?? null;
  const pinned = agents.filter((item) => item.pinned && item.enabled).slice(0, 3);

  useEffect(() => { approvedRef.current = false; setApproved(false); }, [contextAgentId]);
  const completeRun = (target: CodexAgent, wasApproved: boolean) => {
    const result = resultFor(target);
    setContextResult(result); setContextBarState("result");
    const run: Run = { id: `run-${Date.now()}`, agentId: target.id, agentName: target.name, agentIcon: target.icon, status: "completed", sourceApplication: "Selection preview", sourceIcon: "S", workspacePath: target.workspaceMode === "none" ? undefined : "~/Projects/latch-bar", activity: "Result ready", model: target.model === "default" ? "Codex default" : target.model, sandbox: target.sandbox, duration: wasApproved ? "4.3s" : "2.8s", startedAt: "Just now", finalResponse: result, threadId: `thr_preview_${Date.now()}` };
    upsertRun(run);
    manualContinuationRef.current = false;
  };
  useEffect(() => {
    if (contextBarState !== "running" || !agent) return;
    if (manualContinuationRef.current) return;
    timer.current = window.setTimeout(() => {
      if (!approvedRef.current && agent.sandbox !== "read-only" && agent.approvalPolicy !== "never") setContextBarState("approval");
      else completeRun(agent, approvedRef.current);
    }, approvedRef.current ? 1000 : 1250);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [agent, approved, contextBarState, setContextBarState, setContextResult, upsertRun]);

  if (!settings.contextBarEnabled) return null;
  const start = (id: string) => { approvedRef.current = false; setApproved(false); setAllOpen(false); setContextAgentId(id); setContextResult(""); setContextBarState("running"); };
  const cancel = () => { if (timer.current) window.clearTimeout(timer.current); if (manualTimer.current) window.clearTimeout(manualTimer.current); setContextBarState("idle"); setContextAgentId(null); notify("Run cancelled"); };
  const reset = () => { setContextBarState("idle"); setContextAgentId(null); setContextResult(""); };
  const copy = () => { navigator.clipboard?.writeText(contextResult); notify("Result copied"); };

  return <div className={`context-wrap state-${contextBarState}`}>
    {allOpen && <div className="context-menu"><div><span>All agents</span><button onClick={() => setAllOpen(false)}><X size={14} /></button></div>{agents.filter((item) => item.enabled).map((item) => <button key={item.id} onClick={() => start(item.id)}><b className={item.accent}>{item.icon}</b><span><strong>{item.name}</strong><small>{item.description}</small></span></button>)}</div>}
    <div className="context-bar" role="region" aria-label="Latch Context Bar">
      {contextBarState === "idle" && <><div className="context-brand"><span /></div>{pinned.map((item) => <button className="context-action" key={item.id} onClick={() => start(item.id)}><b className={item.accent}>{item.icon}</b><span>{item.name.replace(" writing", "").replace(" engineer", "")}</span></button>)}<button className="context-more" onClick={() => setAllOpen(!allOpen)}><Ellipsis size={18} /></button><span className="context-divider" /><button className="context-expand" onClick={() => { setStudioExpanded(true); notify("Studio opened"); }}><ArrowUpRight size={16} /></button></>}
      {contextBarState === "running" && agent && <><span className="working-icon"><LoaderCircle size={18} /></span><div className="working-copy"><strong>{agent.name} is working…</strong><small>{approved ? "Running npm test" : "Reading selected context"}</small></div><div className="progress-line"><i /></div><button className="context-cancel" onClick={cancel}><Square size={13} fill="currentColor" /></button><button className="context-expand" onClick={() => setStudioExpanded(true)}><ArrowUpRight size={16} /></button></>}
      {contextBarState === "approval" && agent && <><span className="approval-icon"><ShieldAlert size={18} /></span><div className="approval-copy"><strong>Codex wants to run <code>npm test</code></strong><small>~/Projects/latch-bar</small></div><button className="allow-button" onClick={() => { approvedRef.current = true; manualContinuationRef.current = true; setApproved(true); completeRun(agent, true); notify("Command allowed once"); }}>Allow once</button><button className="deny-button" onClick={() => { setContextBarState("error"); notify("Permission denied"); }}>Deny</button><button className="context-expand" onClick={() => setStudioExpanded(true)}><ArrowUpRight size={16} /></button></>}
      {contextBarState === "result" && agent && <><span className="result-icon"><Check size={17} /></span><div className="result-copy"><strong>Result ready</strong><small>{contextResult}</small></div>{agent.outputPolicy.allowReplace && <button className="result-button primary" onClick={() => { notify("Selection replaced"); reset(); }}><Replace size={14} /> Replace</button>}<button className="result-button" onClick={copy}><Copy size={14} /> Copy</button><button className="result-button" onClick={() => setStudioExpanded(true)}><MessageCircle size={14} /> Continue</button><button className="context-expand" onClick={() => setStudioExpanded(true)}><ArrowUpRight size={16} /></button></>}
      {contextBarState === "error" && <><span className="error-icon"><X size={17} /></span><div className="working-copy"><strong>Permission was denied</strong><small>No command was executed</small></div><button className="result-button" onClick={() => { notify("Selected content copied to clipboard"); reset(); }}><Clipboard size={14} /> Copy manually</button><button className="result-button primary" onClick={() => setStudioExpanded(true)}>Open Studio</button><button className="context-cancel" onClick={reset}><X size={14} /></button></>}
    </div>
  </div>;
}
