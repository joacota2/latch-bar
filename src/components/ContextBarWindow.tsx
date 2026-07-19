import { listen } from "@tauri-apps/api/event";
import { ArrowUpRight, Check, Copy, Ellipsis, LoaderCircle, MessageCircle, Pin, Replace, Send, ShieldAlert, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { CodexAgent, CodexSkill, ConversationMessage, McpServer, NativeSelection, Run } from "../domain";
import {
  continueNativeRun,
  copyNativeText,
  focusSelectionApplication,
  hideContextBar,
  interruptNativeRun,
  markContextBarReady,
  openStudio,
  replaceNativeSelection,
  resizeContextBar,
  respondToApproval,
  setContextBarFocusable,
  setOverlayPinned,
  startNativeRun,
  stopNativeRun,
} from "../services/runtime";
import { useLatch } from "../store/LatchStore";

type BarState = "idle" | "running" | "approval" | "result" | "error";

type RpcMessage = {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string };
};

type RuntimeEvent = { runId: string; message: RpcMessage };
type NativePointer = { x: number; y: number; inside: boolean };
type Approval = { requestId: string | number; method: string; title: string; detail: string; params: Record<string, unknown> };
const MAX_COMPACT_PINNED_AGENTS = 7;

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const asText = (value: unknown) => typeof value === "string" ? value : "";
const wait = (milliseconds: number) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

export function ContextBarWindow() {
  const {
    agents,
    mcps,
    skills,
    workspaces,
    refreshCodexEnvironment,
    settings,
    togglePin,
    setContextAgentId,
    setContextBarState,
    setContextResult,
    upsertRun,
  } = useLatch();
  const [selection, setSelection] = useState<NativeSelection | null>(null);
  const [state, setState] = useState<BarState>("idle");
  const [agentId, setAgentId] = useState<string | null>(null);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [approval, setApproval] = useState<Approval | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const [instructionOpen, setInstructionOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [hoveredAgentId, setHoveredAgentId] = useState<string | null>(null);
  const [launchingAgentId, setLaunchingAgentId] = useState<string | null>(null);
  const runId = useRef<string | null>(null);
  const turnActive = useRef(false);
  const starting = useRef(false);
  const startedAt = useRef(0);
  const threadId = useRef<string | undefined>(undefined);
  const resolvedModel = useRef<string>("");
  const resultRef = useRef("");
  const messagesRef = useRef<ConversationMessage[]>([]);
  const selectionRef = useRef<NativeSelection | null>(null);
  const agentRef = useRef<CodexAgent | null>(null);
  const composerCapturedFocus = useRef(false);
  const answerRef = useRef<HTMLDivElement>(null);
  const instructionRef = useRef<HTMLInputElement>(null);
  const enabledAgents = agents.filter((item) => item.enabled).sort((left, right) => left.order - right.order);
  const pinnedAgents = enabledAgents.filter((item) => item.pinned);
  const visiblePinnedAgents = pinnedAgents.slice(0, MAX_COMPACT_PINNED_AGENTS);
  const hiddenPinnedAgentCount = Math.max(0, pinnedAgents.length - visiblePinnedAgents.length);
  const compactWidth = Math.min(430, Math.max(224, 160 + visiblePinnedAgents.length * 31 + (hiddenPinnedAgentCount ? 36 : 0)));
  const agent = agents.find((item) => item.id === agentId) ?? agentRef.current;

  useEffect(() => { resultRef.current = result; }, [result]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { selectionRef.current = selection; }, [selection]);
  useEffect(() => {
    if (!selection) return;
    // Keep transparent room above the compact bar for the agent-name tooltip.
    // Native webview contents cannot paint outside their window bounds.
    let height = 86;
    let width = compactWidth;
    if (state === "idle" && showAll) {
      height = Math.min(320, 96 + Math.ceil(enabledAgents.length / 2) * 50);
      width = 560;
    }
    if (state === "running" || state === "result") height = instructionOpen ? 360 : 300;
    if (state === "running" || state === "result") width = 660;
    if (state === "approval") { height = 220; width = 620; }
    if (state === "error") { height = 195; width = 620; }
    const anchorX = selection.bounds.x + selection.bounds.width / 2;
    void resizeContextBar(height, width, anchorX).catch(() => undefined);
  }, [compactWidth, enabledAgents.length, instructionOpen, selection, showAll, state]);
  useEffect(() => {
    if (answerRef.current) answerRef.current.scrollTop = answerRef.current.scrollHeight;
  }, [messages, result, state]);
  useEffect(() => {
    if (instructionOpen) window.setTimeout(() => instructionRef.current?.focus(), 60);
  }, [instructionOpen]);

  const appendMessage = useCallback((message: ConversationMessage) => {
    const next = [...messagesRef.current, message];
    messagesRef.current = next;
    setMessages(next);
    return next;
  }, []);

  const saveRun = useCallback((status: Run["status"], finalResponse?: string, activity?: string, conversation = messagesRef.current) => {
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
      model: resolvedModel.current || (activeAgent.model === "default" ? "Codex default" : activeAgent.model),
      sandbox: activeAgent.sandbox,
      duration,
      startedAt: new Date(startedAt.current || Date.now()).toISOString(),
      finalResponse,
      threadId: threadId.current,
      conversation,
    });
  }, [upsertRun]);

  const finish = useCallback(async (message: RpcMessage) => {
    const completedRunId = runId.current;
    const turn = asRecord(message.params?.turn);
    const status = asText(turn.status);
    const items = Array.isArray(turn.items) ? turn.items.map(asRecord) : [];
    const finalMessage = [...items].reverse().find((item) => item.type === "agentMessage");
    const finalText = asText(finalMessage?.text) || resultRef.current;
    let shouldHide = false;

    if (status === "failed") {
      const turnError = asRecord(turn.error);
      const detail = asText(turnError.message) || "Codex could not complete this run";
      setError(detail);
      setState("error");
      setContextBarState("error");
      saveRun("failed", undefined, detail);
    } else if (status === "interrupted") {
      saveRun("cancelled", undefined, "Cancelled");
      shouldHide = true;
    } else {
      const completedText = finalText || "Codex completed without a text response.";
      resultRef.current = completedText;
      setResult(completedText);
      const conversation = appendMessage({ id: `assistant-${Date.now()}`, role: "assistant", text: completedText });
      setContextResult(completedText);
      setState("result");
      setContextBarState("result");
      saveRun("completed", completedText, undefined, conversation);
    }

    turnActive.current = false;
    starting.current = false;
    if (completedRunId && (status === "failed" || status === "interrupted")) {
      void stopNativeRun(completedRunId).catch(() => undefined);
      runId.current = null;
    }
    await setOverlayPinned(composerCapturedFocus.current && !shouldHide);
    if (shouldHide) {
      agentRef.current = null;
      selectionRef.current = null;
      setSelection(null);
      await setContextBarFocusable(false).catch(() => undefined);
      await hideContextBar();
    }
  }, [appendMessage, saveRun, setContextBarState, setContextResult]);

  const handleMessage = useCallback((message: RpcMessage) => {
    if (message.error) {
      const detail = message.error.message || "Codex app-server returned an error";
      setError(detail);
      setState("error");
      setContextBarState("error");
      saveRun("failed", undefined, detail);
      const failedRunId = runId.current;
      runId.current = null;
      turnActive.current = false;
      starting.current = false;
      if (failedRunId) void stopNativeRun(failedRunId).catch(() => undefined);
      void setOverlayPinned(composerCapturedFocus.current).catch(() => undefined);
      return;
    }
    if (message.id === 1) {
      const response = asRecord(message.result);
      threadId.current = asText(asRecord(response.thread).id) || threadId.current;
      resolvedModel.current = asText(response.model) || resolvedModel.current;
    }
    if (message.method === "error") {
      const rpcError = asRecord(message.params?.error);
      setError(asText(rpcError.message) || "Codex app-server returned an error");
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
      if (turnActive.current || starting.current) return;
      const previousRunId = runId.current;
      if (previousRunId) void stopNativeRun(previousRunId).catch(() => undefined);
      runId.current = null;
      threadId.current = undefined;
      resolvedModel.current = "";
      composerCapturedFocus.current = false;
      setSelection(payload);
      setAgentId(null);
      setState("idle");
      setShowAll(false);
      setInstructionOpen(false);
      setInstruction("");
      setError("");
      setResult("");
      messagesRef.current = [];
      setMessages([]);
      setCopied(false);
    });
    const unlistenRuntime = listen<RuntimeEvent>("codex-event", ({ payload }) => {
      if (!runId.current && starting.current) runId.current = payload.runId;
      if (payload.runId === runId.current) handleMessage(payload.message);
    });
    const unlistenPointer = listen<NativePointer>("context-pointer-position", ({ payload }) => {
      document.querySelectorAll(".is-native-hovered").forEach((element) => element.classList.remove("is-native-hovered"));
      if (!payload.inside) return;
      const element = document.elementFromPoint?.(payload.x, payload.y);
      const button = element?.closest("button");
      button?.classList.add("is-native-hovered");
      button?.closest(".context-agent-option")?.classList.add("is-native-hovered");
    });
    void Promise.all([unlistenSelection, unlistenRuntime, unlistenPointer])
      .then(() => markContextBarReady())
      .catch(() => undefined);
    return () => {
      void unlistenSelection.then((unlisten) => unlisten());
      void unlistenRuntime.then((unlisten) => unlisten());
      void unlistenPointer.then((unlisten) => unlisten());
    };
  }, [handleMessage]);

  const launchRun = async (runtimeAgent: CodexAgent, displayAgent: CodexAgent, source: NativeSelection, activity: string, runtimeSkills: CodexSkill[] = skills, runtimeMcps: McpServer[] = mcps) => {
    setShowAll(false);
    setInstructionOpen(false);
    setAgentId(displayAgent.id);
    setContextAgentId(displayAgent.id);
    setContextResult("");
    setContextBarState("running");
    resultRef.current = "";
    setResult("");
    messagesRef.current = [];
    setMessages([]);
    setCopied(false);
    setError("");
    setApproval(null);
    setState("running");
    startedAt.current = Date.now();
    threadId.current = undefined;
    resolvedModel.current = "";
    agentRef.current = displayAgent;
    starting.current = true;
    turnActive.current = true;
    await setOverlayPinned(true);
    try {
      const response = await startNativeRun(runtimeAgent, {
        selection: source.text,
        application: source.application,
        windowTitle: displayAgent.contextPolicy.includeWindowTitle ? source.windowTitle : undefined,
        workspace: runtimeAgent.fixedWorkspacePath,
      }, runtimeSkills, runtimeMcps);
      runId.current = response.runId;
      saveRun("running", undefined, activity);
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : String(caught);
      setError(detail);
      setState("error");
      setContextBarState("error");
      runId.current = null;
      turnActive.current = false;
      await setOverlayPinned(composerCapturedFocus.current);
    } finally {
      starting.current = false;
    }
  };

  const start = async (target: CodexAgent) => {
    const source = selectionRef.current ?? selection;
    if (!source || starting.current) return;
    composerCapturedFocus.current = false;
    const workspace = target.workspaceMode === "fixed"
      ? target.fixedWorkspacePath
      : target.workspaceMode === "recent-project"
        ? workspaces[0]?.path
        : undefined;
    const runtimeAgent: CodexAgent = workspace
      ? { ...target, workspaceMode: "fixed", fixedWorkspacePath: workspace }
      : { ...target, workspaceMode: "none", fixedWorkspacePath: undefined };
    const usesNamedProfile = Boolean(target.codexProfile && target.codexProfile !== "default");
    const environment = workspace || usesNamedProfile
      ? await refreshCodexEnvironment(workspace, target.codexProfile)
      : null;
    await launchRun(runtimeAgent, runtimeAgent, source, "Codex is working", environment?.skills ?? skills, environment?.mcpServers ?? mcps);
  };

  const chooseAgent = async (target: CodexAgent) => {
    if (launchingAgentId || starting.current) return;
    setLaunchingAgentId(target.id);
    try {
      await setOverlayPinned(true);
      const source = selectionRef.current ?? selection;
      if (source) await focusSelectionApplication(source.processId).catch(() => undefined);
      await wait(130);
      await start(target);
    } finally {
      setLaunchingAgentId(null);
    }
  };

  const toggleAgentPicker = async () => {
    const opening = !showAll;
    setShowAll(opening);
    await setOverlayPinned(opening);
  };

  const closeAgentPicker = async () => {
    setShowAll(false);
    await setOverlayPinned(false);
  };

  const redirectToStudio = async () => {
    await setOverlayPinned(false).catch(() => undefined);
    await openStudio();
  };

  const openContinuation = async () => {
    if (state !== "result") return;
    composerCapturedFocus.current = true;
    setInstructionOpen(true);
    await setOverlayPinned(true);
    await setContextBarFocusable(true);
  };

  const closeContinuation = async () => {
    const source = selectionRef.current;
    setInstructionOpen(false);
    setInstruction("");
    composerCapturedFocus.current = false;
    await setContextBarFocusable(false).catch(() => undefined);
    if (source) await focusSelectionApplication(source.processId).catch(() => undefined);
    await setOverlayPinned(false);
  };

  const continueRun = async (event: FormEvent) => {
    event.preventDefault();
    const followUp = instruction.trim();
    const source = selectionRef.current;
    const baseAgent = agentRef.current;
    const id = runId.current;
    if (!followUp || !source || !baseAgent || !id || starting.current) return;
    appendMessage({ id: `user-${Date.now()}`, role: "user", text: followUp });
    setInstruction("");
    setInstructionOpen(false);
    resultRef.current = "";
    setResult("");
    setCopied(false);
    setContextResult("");
    setContextBarState("running");
    setState("running");
    composerCapturedFocus.current = false;
    starting.current = true;
    turnActive.current = true;
    await setContextBarFocusable(false).catch(() => undefined);
    await focusSelectionApplication(source.processId).catch(() => undefined);
    try {
      await continueNativeRun(id, followUp);
      saveRun("running", undefined, "Applying follow-up instructions");
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : String(caught);
      setError(detail);
      setState("error");
      setContextBarState("error");
      turnActive.current = false;
      saveRun("failed", undefined, detail);
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
    turnActive.current = false;
    agentRef.current = null;
    selectionRef.current = null;
    composerCapturedFocus.current = false;
    setSelection(null);
    setContextAgentId(null);
    setContextBarState("idle");
    await setContextBarFocusable(false).catch(() => undefined);
    await setOverlayPinned(false);
    await hideContextBar();
  };

  const close = async () => {
    const id = runId.current;
    if (id) await stopNativeRun(id).catch(() => undefined);
    runId.current = null;
    turnActive.current = false;
    agentRef.current = null;
    selectionRef.current = null;
    composerCapturedFocus.current = false;
    setSelection(null);
    setContextAgentId(null);
    setContextBarState("idle");
    await setContextBarFocusable(false).catch(() => undefined);
    await setOverlayPinned(false);
    await hideContextBar();
  };

  const replace = async () => {
    const source = selectionRef.current;
    const sourceAllowsReplacement = source?.replacementCapability === "accessibility" || source?.replacementCapability === "clipboardPaste";
    if (state !== "result" || !resultRef.current || !agent?.outputPolicy.allowReplace || !sourceAllowsReplacement) return;
    try {
      await replaceNativeSelection(resultRef.current);
      await close();
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : String(caught);
      setError(detail);
      setState("error");
      setContextBarState("error");
    }
  };

  const agentButton = (item: CodexAgent, picker = false) => {
    const active = hoveredAgentId === item.id;
    const launching = launchingAgentId === item.id;
    const className = `${picker ? "context-agent-option" : "context-action"}${active ? " is-hovered" : ""}${launching ? " is-launching" : ""}`;
    if (picker) return <div
      className={className}
      onPointerEnter={() => setHoveredAgentId(item.id)}
      onPointerLeave={() => setHoveredAgentId((current) => current === item.id ? null : current)}
    >
      <button type="button" className="context-agent-run" onClick={() => void chooseAgent(item)} aria-label={`Run ${item.name}`}>
        <b className={item.accent}>{item.icon}</b>
        <span><strong>{item.name}</strong><small>{item.description}</small></span>
      </button>
      <button type="button" className={`context-agent-pin${item.pinned ? " is-pinned" : ""}`} onClick={() => togglePin(item.id)} aria-label={`${item.pinned ? "Unpin" : "Pin"} ${item.name}`} title={`${item.pinned ? "Unpin from" : "Pin to"} Context Bar`}>
        <Pin size={13} fill={item.pinned ? "currentColor" : "none"} />
      </button>
    </div>;
    return <button
      type="button"
      className={className}
      data-agent-name={item.name}
      onPointerEnter={() => setHoveredAgentId(item.id)}
      onPointerLeave={() => setHoveredAgentId((current) => current === item.id ? null : current)}
      onClick={() => void chooseAgent(item)}
      aria-label={`Run ${item.name}`}
    >
      <b className={item.accent}>{item.icon}</b>
      <span className="context-agent-tooltip" aria-hidden="true">{item.name}</span>
    </button>;
  };

  if (!settings.contextBarEnabled || !selection) return null;
  const running = state === "running";
  const completed = state === "result";
  const replacementDisabledReason = agent && !agent.outputPolicy.allowReplace
    ? `Replacement is disabled for ${agent.name}`
    : selection.replacementCapability !== "accessibility" && selection.replacementCapability !== "clipboardPaste"
      ? "The selected text is read-only"
      : undefined;
  const sourceAllowsReplacement = selection.replacementCapability === "accessibility" || selection.replacementCapability === "clipboardPaste";
  const canReplace = Boolean(completed && result && agent?.outputPolicy.allowReplace && sourceAllowsReplacement);

  return <div className={`context-wrap context-native state-${state}${showAll ? " picker-open" : ""}`}>
    <div className="context-bar" role="region" aria-label="Latch Context Bar" onPointerDownCapture={() => void setOverlayPinned(true)}>
      <div className="context-state" key={`${state}-${showAll ? "picker" : "bar"}`}>
        {state === "idle" && <div className="context-idle-view">
          <div className="context-idle-header">
            <div className="context-brand" title={`Selected in ${selection.application}`}><span /></div>
            <div className="context-pinned-agents">
              {visiblePinnedAgents.length > 0 ? visiblePinnedAgents.map((item) => <span key={item.id}>{agentButton(item)}</span>) : <span className="context-empty-pins">No pinned agents</span>}
            </div>
            {hiddenPinnedAgentCount > 0 && <button type="button" className="context-overflow-count" onClick={() => void toggleAgentPicker()} aria-label={`Show ${hiddenPinnedAgentCount} more pinned agents`} title={`${hiddenPinnedAgentCount} more pinned agents`}>+{hiddenPinnedAgentCount}</button>}
            <button type="button" className={`context-more${showAll ? " is-active" : ""}`} onClick={() => void toggleAgentPicker()} aria-expanded={showAll} aria-label="Choose another agent" title="Choose another agent"><Ellipsis size={16} /></button>
            <span className="context-divider" />
            <button type="button" className="context-redirect" onClick={() => void redirectToStudio()} aria-label="Open Studio" title="Open Studio"><ArrowUpRight size={14} /></button>
            <button type="button" className="context-cancel" onClick={() => void close()} aria-label="Close" title="Close"><X size={12} /></button>
          </div>
          {showAll && <div className="context-agent-picker" role="menu" aria-label="All agents">
            <header><div><strong>Choose an agent</strong><small>Runs here in the Context Bar</small></div><button type="button" onClick={() => void closeAgentPicker()} aria-label="Close agent picker"><X size={14} /></button></header>
            <div className="context-agent-grid">{enabledAgents.map((item) => <span key={item.id}>{agentButton(item, true)}</span>)}</div>
          </div>}
        </div>}

        {(running || completed) && agent && <div className="context-run-view">
          <header className="context-run-header">
            <span className={running ? "working-icon" : "result-icon"}>{running ? <LoaderCircle size={18} /> : <Check size={17} />}</span>
            <div className="context-run-copy"><strong>{agent.name}</strong><small>{running ? "Streaming response in Latch" : "Answer ready in Latch"}</small></div>
            <div className="context-run-actions">
              <button type="button" className="result-button" disabled={!completed} onClick={() => void openContinuation()}><MessageCircle size={14} /> Continue</button>
              {running && <button type="button" className="result-button danger" onClick={() => void cancel()}><Square size={12} fill="currentColor" /> Cancel</button>}
              <button type="button" className="result-button primary" disabled={!canReplace} title={replacementDisabledReason} onClick={() => void replace()}><Replace size={14} /> Replace</button>
              <button type="button" className="context-copy" disabled={!result} onClick={async () => { await copyNativeText(result); setCopied(true); }} aria-label="Copy response"><Copy size={15} /><span>{copied ? "Copied" : "Copy"}</span></button>
              <button type="button" className="context-redirect" onClick={() => void redirectToStudio()} aria-label="Open in Studio"><ArrowUpRight size={16} /></button>
              {completed && <button type="button" className="context-cancel" onClick={() => void close()} aria-label="Close"><X size={14} /></button>}
            </div>
          </header>
          {running && <div className="context-stream-progress"><i /></div>}
          <div ref={answerRef} className={`context-answer context-conversation${running ? " is-streaming" : ""}`} role="log" aria-live="polite">
            {messages.map((message) => <article key={message.id} className={`context-chat-message ${message.role}`}>
              <span>{message.role === "user" ? "You" : agent.name}</span>
              <p>{message.text}</p>
            </article>)}
            {running && <article className="context-chat-message assistant is-streaming">
              <span>{agent.name}</span>
              {result ? <p>{result}</p> : <div className="context-stream-placeholder"><i /><span>Codex is preparing the response…</span></div>}
            </article>}
          </div>
          {instructionOpen && <form className="context-follow-up" onSubmit={(event) => void continueRun(event)}>
            <MessageCircle size={15} />
            <input ref={instructionRef} aria-label="Additional instructions" value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="Add instructions for the next response…" />
            <button type="submit" disabled={!instruction.trim()}><Send size={14} /> Continue</button>
            <button type="button" aria-label="Cancel additional instructions" onClick={() => void closeContinuation()}><X size={14} /></button>
          </form>}
        </div>}

        {state === "approval" && approval && <div className="context-run-view">
          <header className="context-run-header"><span className="approval-icon"><ShieldAlert size={18} /></span><div className="context-run-copy"><strong>{approval.title}</strong><small>Codex needs your approval to continue here</small></div><div className="context-run-actions"><button type="button" className="allow-button" onClick={() => void answerApproval(true)}>Allow once</button><button type="button" className="deny-button" onClick={() => void answerApproval(false)}>Deny</button><button type="button" className="context-redirect" onClick={() => void redirectToStudio()} aria-label="Open in Studio"><ArrowUpRight size={16} /></button><button type="button" className="context-cancel" onClick={() => void cancel()} aria-label="Cancel"><X size={14} /></button></div></header>
          <div className="context-approval-detail">{approval.detail}</div>
        </div>}

        {state === "error" && <div className="context-run-view">
          <header className="context-run-header"><span className="error-icon"><X size={17} /></span><div className="context-run-copy"><strong>Run failed</strong><small>The error is shown below</small></div><div className="context-run-actions">{result && <button type="button" className="result-button" onClick={() => void copyNativeText(result)}><Copy size={14} /> Copy partial</button>}<button type="button" className="context-redirect" onClick={() => void redirectToStudio()} aria-label="Open in Studio"><ArrowUpRight size={16} /></button><button type="button" className="context-cancel" onClick={() => void close()} aria-label="Close"><X size={14} /></button></div></header>
          <div className="context-error-detail">{error}</div>
        </div>}
      </div>
    </div>
  </div>;
}
