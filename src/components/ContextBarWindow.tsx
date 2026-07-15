import { listen } from "@tauri-apps/api/event";
import { open as openPath } from "@tauri-apps/plugin-dialog";
import { ArrowUpRight, Check, Copy, Ellipsis, LoaderCircle, Replace, ShieldAlert, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CodexAgent, NativeSelection, Run } from "../domain";
import {
  copyNativeText,
  hideContextBar,
  interruptNativeRun,
  openStudio,
  replaceNativeSelection,
  respondToApproval,
  setOverlayPinned,
  startNativeRun,
  stopNativeRun,
} from "../services/runtime";
import { useLatch } from "../store/LatchStore";

type RpcMessage = {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string };
};

type RuntimeEvent = { runId: string; message: RpcMessage };
type Approval = { requestId: string | number; method: string; title: string; detail: string; params: Record<string, unknown> };

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const asText = (value: unknown) => typeof value === "string" ? value : "";

export function ContextBarWindow() {
  const {
    agents,
    settings,
    setContextAgentId,
    setContextBarState,
    setContextResult,
    upsertRun,
  } = useLatch();
  const [selection, setSelection] = useState<NativeSelection | null>(null);
  const [state, setState] = useState<"idle" | "running" | "approval" | "result" | "error">("idle");
  const [agentId, setAgentId] = useState<string | null>(null);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [approval, setApproval] = useState<Approval | null>(null);
  const [showAll, setShowAll] = useState(false);
  const runId = useRef<string | null>(null);
  const starting = useRef(false);
  const startedAt = useRef(0);
  const threadId = useRef<string | undefined>(undefined);
  const resultRef = useRef("");
  const selectionRef = useRef<NativeSelection | null>(null);
  const agentRef = useRef<CodexAgent | null>(null);
  const pinned = agents.filter((item) => item.pinned && item.enabled).slice(0, 3);
  const visibleAgents = showAll ? agents.filter((item) => item.enabled).slice(0, 6) : pinned;
  const agent = agents.find((item) => item.id === agentId) ?? null;

  useEffect(() => { resultRef.current = result; }, [result]);
  useEffect(() => { selectionRef.current = selection; }, [selection]);

  const saveRun = useCallback((status: Run["status"], finalResponse?: string, activity?: string) => {
    const activeAgent = agentRef.current;
    const source = selectionRef.current;
    const id = runId.current;
    if (!activeAgent || !source || !id) return;
    const duration = startedAt.current ? `${((Date.now() - startedAt.current) / 1000).toFixed(1)}s` : undefined;
    upsertRun({
      id,
      agentId: activeAgent.id,
      agentName: activeAgent.name,
      agentIcon: activeAgent.icon,
      status,
      sourceApplication: source.application,
      sourceIcon: source.application.slice(0, 2).toUpperCase(),
      workspacePath: activeAgent.fixedWorkspacePath,
      activity: activity ?? (status === "completed" ? "Result ready" : status === "approval" ? "Waiting for approval" : status),
      model: activeAgent.model === "default" ? "Codex default" : activeAgent.model,
      sandbox: activeAgent.sandbox,
      duration,
      startedAt: new Date(startedAt.current || Date.now()).toISOString(),
      finalResponse,
      threadId: threadId.current,
    });
  }, [upsertRun]);

  const finish = useCallback(async (message: RpcMessage) => {
    const turn = asRecord(message.params?.turn);
    const status = asText(turn.status);
    const items = Array.isArray(turn.items) ? turn.items.map(asRecord) : [];
    const finalMessage = [...items].reverse().find((item) => item.type === "agentMessage");
    const finalText = asText(finalMessage?.text) || resultRef.current;
    if (status === "failed") {
      const turnError = asRecord(turn.error);
      const detail = asText(turnError.message) || "Codex could not complete this run";
      setError(detail);
      setState("error");
      setContextBarState("error");
      saveRun("failed", undefined, detail);
    } else if (status === "interrupted") {
      saveRun("cancelled", undefined, "Cancelled");
      await setOverlayPinned(false);
      await hideContextBar();
    } else {
      const completedText = finalText || "Codex completed without a text response.";
      setResult(completedText);
      setContextResult(completedText);
      setState("result");
      setContextBarState("result");
      saveRun("completed", completedText);
    }
    if (runId.current) void stopNativeRun(runId.current).catch(() => undefined);
  }, [saveRun, setContextBarState, setContextResult]);

  const handleMessage = useCallback((message: RpcMessage) => {
    if (message.error) {
      const detail = message.error.message || "Codex app-server returned an error";
      setError(detail);
      setState("error");
      setContextBarState("error");
      saveRun("failed", undefined, detail);
      return;
    }
    if (message.id === 1) {
      const response = asRecord(message.result);
      threadId.current = asText(asRecord(response.thread).id) || threadId.current;
    }
    if (message.method === "error") {
      const rpcError = asRecord(message.params?.error);
      const detail = asText(rpcError.message) || "Codex app-server returned an error";
      setError(detail);
      return;
    }
    if (message.method === "item/agentMessage/delta") {
      const delta = asText(message.params?.delta);
      if (delta) {
        resultRef.current += delta;
        setResult(resultRef.current);
      }
      return;
    }
    if (message.method === "item/completed") {
      const item = asRecord(message.params?.item);
      if (item.type === "agentMessage" && asText(item.text)) {
        resultRef.current = asText(item.text);
        setResult(resultRef.current);
      }
      return;
    }
    if (message.method === "turn/completed") {
      void finish(message);
      return;
    }
    if (message.id !== undefined && [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
    ].includes(message.method ?? "")) {
      const params = asRecord(message.params);
      const command = asText(params.command);
      const title = command ? `Codex wants to run ${command}` : message.method === "item/fileChange/requestApproval" ? "Codex wants to change files" : "Codex requests additional access";
      const detail = asText(params.cwd) || asText(params.reason) || "Review this request before continuing";
      setApproval({ requestId: message.id, method: message.method!, title, detail, params });
      setState("approval");
      setContextBarState("approval");
      saveRun("approval", undefined, title);
    }
  }, [finish, saveRun, setContextBarState]);

  useEffect(() => {
    const unlistenSelection = listen<NativeSelection>("native-selection", ({ payload }) => {
      if (runId.current) return;
      setSelection(payload);
      setState("idle");
      setError("");
      setResult("");
    });
    const unlistenRuntime = listen<RuntimeEvent>("codex-event", ({ payload }) => {
      if (!runId.current && starting.current) runId.current = payload.runId;
      if (payload.runId === runId.current) handleMessage(payload.message);
    });
    return () => { void unlistenSelection.then((unlisten) => unlisten()); void unlistenRuntime.then((unlisten) => unlisten()); };
  }, [handleMessage]);

  const start = async (target: CodexAgent) => {
    if (!selection) return;
    let workspace = target.workspaceMode === "fixed" ? target.fixedWorkspacePath : undefined;
    if (target.workspaceMode !== "none" && target.workspaceMode !== "fixed") {
      const picked = await openPath({ directory: true, multiple: false, title: `Choose a workspace for ${target.name}` });
      if (!picked) return;
      workspace = picked;
    }
    const runtimeAgent: CodexAgent = workspace
      ? { ...target, workspaceMode: "fixed", fixedWorkspacePath: workspace }
      : target;
    setShowAll(false);
    setAgentId(target.id);
    setContextAgentId(target.id);
    setContextResult("");
    setContextBarState("running");
    resultRef.current = "";
    setResult("");
    setError("");
    setApproval(null);
    setState("running");
    startedAt.current = Date.now();
    threadId.current = undefined;
    agentRef.current = target;
    starting.current = true;
    await setOverlayPinned(true);
    try {
      const response = await startNativeRun(runtimeAgent, {
        selection: selection.text,
        application: selection.application,
        windowTitle: target.contextPolicy.includeWindowTitle ? selection.windowTitle : undefined,
        workspace,
      });
      runId.current = response.runId;
      saveRun("running", undefined, "Codex is working");
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : String(caught);
      setError(detail);
      setState("error");
      setContextBarState("error");
      await setOverlayPinned(false);
    } finally {
      starting.current = false;
    }
  };

  const answerApproval = async (allow: boolean) => {
    if (!approval || !runId.current) return;
    const isPermission = approval.method === "item/permissions/requestApproval";
    const requested = asRecord(approval.params.permissions);
    const granted: Record<string, unknown> = {};
    if (allow && requested.network) granted.network = requested.network;
    if (allow && requested.fileSystem) granted.fileSystem = requested.fileSystem;
    const response = isPermission
      ? { permissions: granted, scope: "turn" }
      : { decision: allow ? "accept" : "decline" };
    await respondToApproval(runId.current, approval.requestId, response);
    setApproval(null);
    setState("running");
    setContextBarState("running");
  };

  const cancel = async () => {
    const id = runId.current;
    if (id) {
      await interruptNativeRun(id).catch(() => undefined);
      await stopNativeRun(id).catch(() => undefined);
      saveRun("cancelled", undefined, "Cancelled");
    }
    runId.current = null;
    agentRef.current = null;
    setContextAgentId(null);
    setContextBarState("idle");
    await setOverlayPinned(false);
    await hideContextBar();
  };

  const close = async () => {
    const id = runId.current;
    if (id && state !== "result") await stopNativeRun(id).catch(() => undefined);
    runId.current = null;
    agentRef.current = null;
    setContextAgentId(null);
    setContextBarState("idle");
    await setOverlayPinned(false);
    await hideContextBar();
  };

  if (!settings.contextBarEnabled || !selection) return null;
  return <div className={`context-wrap context-native state-${state}`}>
    <div className="context-bar" role="region" aria-label="Latch Context Bar">
      {state === "idle" && <><div className="context-brand" title={`Selected in ${selection.application}`}><span /></div>{visibleAgents.map((item) => <button className="context-action" key={item.id} onClick={() => void start(item)}><b className={item.accent}>{item.icon}</b><span>{item.name.replace(" writing", "").replace(" engineer", "")}</span></button>)}<button className="context-more" onClick={() => setShowAll(!showAll)} aria-label="All agents"><Ellipsis size={18} /></button><span className="context-divider" /><button className="context-expand" onClick={() => void openStudio()} aria-label="Open Studio"><ArrowUpRight size={16} /></button><button className="context-cancel" onClick={() => void close()} aria-label="Close"><X size={14} /></button></>}
      {state === "running" && agent && <><span className="working-icon"><LoaderCircle size={18} /></span><div className="working-copy"><strong>{agent.name} is working…</strong><small>{result ? result.slice(-90) : `Using selected text from ${selection.application}`}</small></div><div className="progress-line"><i /></div><button className="context-cancel" onClick={() => void cancel()} aria-label="Cancel"><Square size={13} fill="currentColor" /></button><button className="context-expand" onClick={() => void openStudio()} aria-label="Open Studio"><ArrowUpRight size={16} /></button></>}
      {state === "approval" && approval && <><span className="approval-icon"><ShieldAlert size={18} /></span><div className="approval-copy"><strong>{approval.title}</strong><small>{approval.detail}</small></div><button className="allow-button" onClick={() => void answerApproval(true)}>Allow once</button><button className="deny-button" onClick={() => void answerApproval(false)}>Deny</button><button className="context-expand" onClick={() => void openStudio()} aria-label="Open Studio"><ArrowUpRight size={16} /></button></>}
      {state === "result" && agent && <><span className="result-icon"><Check size={17} /></span><div className="result-copy"><strong>Result ready</strong><small>{result}</small></div>{agent.outputPolicy.allowReplace && <button className="result-button primary" onClick={async () => { await replaceNativeSelection(result); await close(); }}><Replace size={14} /> Replace</button>}<button className="result-button" onClick={() => void copyNativeText(result)}><Copy size={14} /> Copy</button><button className="result-button" onClick={() => void openStudio()}>Studio</button><button className="context-cancel" onClick={() => void close()} aria-label="Close"><X size={14} /></button></>}
      {state === "error" && <><span className="error-icon"><X size={17} /></span><div className="working-copy"><strong>Run failed</strong><small>{error}</small></div>{result && <button className="result-button" onClick={() => void copyNativeText(result)}><Copy size={14} /> Copy partial</button>}<button className="result-button primary" onClick={() => void openStudio()}>Open Studio</button><button className="context-cancel" onClick={() => void close()} aria-label="Close"><X size={14} /></button></>}
    </div>
  </div>;
}
