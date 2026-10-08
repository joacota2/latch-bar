import { performOutputAction } from "../services/outputActions";
import { RuntimeEventAdapter } from "../services/runtimeEvents";
import { Conversation } from "./context/Conversation";
import { useEvent } from "../hooks/useEvent";
import { validateRuntimeAgent } from "../services/environments";
import { handoffResult } from "../services/transientResults";
import { useContextSession } from "../hooks/useContextSession";
import { asRecord, asText, parseApproval, approvalResponse, type RpcMessage, type RuntimeEvent } from "../services/approvals";
import { ApprovalDetails } from "./context/ApprovalDetails";
import type { BarState } from "../services/contextSession";
import { randomUUID } from "../services/compat";
import { listen } from "@tauri-apps/api/event";
import { ArrowUpRight, Check, Copy, Ellipsis, LoaderCircle, MessageCircle, Pin, Replace, Send, ShieldAlert, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { CodexAgent, CodexSkill, ConversationMessage, McpServer, NativeSelection, Run } from "../domain";
import {
  chooseWorkspaceFolder,
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
import { installingUpdate, onUpdateState } from "../services/updates";

type NativePointer = { x: number; y: number; inside: boolean };
const MAX_COMPACT_PINNED_AGENTS = 7;

const wait = (milliseconds: number) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

export function ContextBarWindow() {
  const [updating, setUpdating] = useState(false);
  useEffect(() => {
    const subscription = onUpdateState((next) => setUpdating(installingUpdate(next.phase)));
    return () => { void subscription.then((dispose) => dispose()); };
  }, []);
  const {
    agents,
    mcps,
    skills,
    ready, resetEpoch, recentWorkspace,
    refreshCodexEnvironment, migrateAgentSkills,
    settings,
    togglePin,
    upsertRun,
  } = useLatch();
  const { session, snapshot: sessionRef, dispatch, patch } = useContextSession();
  const { selection, state, result, messages, replacementStatus, replacing } = session;
  const approval = session.approvals[0] ?? null;
  const setSelection = useCallback((selection: NativeSelection | null) => patch({ selection }), [patch]);
  const setState = useCallback((state: BarState) => patch({ state }), [patch]);
  const setResult = useCallback((result: string) => patch({ result }), [patch]);
  const setMessages = useCallback((messages: ConversationMessage[]) => patch({ messages }), [patch]);
  const setReplacementStatus = useCallback((replacementStatus: string) => patch({ replacementStatus }), [patch]);
  const setReplacing = useCallback((replacing: boolean) => patch({ replacing }), [patch]);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [instructionOpen, setInstructionOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [hoveredAgentId, setHoveredAgentId] = useState<string | null>(null);
  const clearAgentHover = useCallback(() => {
    setHoveredAgentId(null);
    document.querySelectorAll(".is-native-hovered").forEach((element) => element.classList.remove("is-native-hovered"));
  }, []);
  const launchingAgentId = session.launchingAgentId;
  const setLaunchingAgentId = (value: string | null) => patch({ launchingAgentId: value });
  const outputActionRef = useRef<(agent: CodexAgent, source: NativeSelection, text: string) => Promise<void>>(async () => undefined);
  const [handoffFailed, setHandoffFailed] = useState(false);
  useEffect(() => { patch({ captureEnabled: ready && settings.contextBarEnabled }); }, [patch, ready, settings.contextBarEnabled]);
  const [approvalError, setApprovalError] = useState("");
  const approvalPending = session.approvalInFlight;
  const setApprovalPending = (value: boolean) => patch({ approvalInFlight: value });
  const answerRef = useRef<HTMLDivElement>(null);
  const instructionRef = useRef<HTMLInputElement>(null);
  const enabledAgents = agents.filter((item) => item.enabled).sort((left, right) => left.order - right.order);
  const pinnedAgents = enabledAgents.filter((item) => item.pinned);
  const visiblePinnedAgents = pinnedAgents.slice(0, MAX_COMPACT_PINNED_AGENTS);
  const hiddenPinnedAgentCount = Math.max(0, pinnedAgents.length - visiblePinnedAgents.length);
  const compactWidth = Math.min(430, Math.max(224, 160 + visiblePinnedAgents.length * 31 + (hiddenPinnedAgentCount ? 36 : 0)));
  const agent = agents.find((item) => item.id === agentId) ?? sessionRef.current.activeAgent;

  useEffect(() => {
    if (!selection) { void resizeContextBar(86, compactWidth).catch(() => undefined); return; }
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
    if (state === "approval") { height = 360; width = 620; }
    if (state === "error") { height = 195; width = 620; }
    const anchorX = selection.bounds.x + selection.bounds.width / 2;
    void resizeContextBar(height, width, anchorX).catch(() => undefined);
  }, [compactWidth, enabledAgents.length, instructionOpen, selection, showAll, state]);
  useEffect(() => {
    if (answerRef.current) answerRef.current.scrollTop = answerRef.current.scrollHeight;
  }, [messages, result, state]);
  useEffect(() => {
    const generation = sessionRef.current.generation;
    if (!instructionOpen) return;
    const timer = window.setTimeout(() => { if (sessionRef.current.generation === generation) instructionRef.current?.focus(); }, 60);
    return () => window.clearTimeout(timer);
  }, [instructionOpen, sessionRef]);

  const appendMessage = useCallback((message: ConversationMessage) => {
    const next = [...sessionRef.current.messages, message];
    setMessages(next);
    return next;
  }, [sessionRef, setMessages]);

  const saveRun = useCallback((status: Run["status"], finalResponse?: string, activity?: string, conversation = sessionRef.current.messages) => {
    const activeAgent = sessionRef.current.activeAgent;
    const source = sessionRef.current.selection;
    const id = sessionRef.current.historyId;
    if (!activeAgent || !source || !id) return;
    const duration = sessionRef.current.startedAt ? `${((Date.now() - sessionRef.current.startedAt) / 1000).toFixed(1)}s` : undefined;
    const run: Run = {
      id,
      agentId: activeAgent.id,
      agentName: activeAgent.name,
      agentIcon: activeAgent.icon,
      status,
      sourceApplication: source.application,
      sourceIcon: source.application.slice(0, 2).toUpperCase(),
      workspacePath: activeAgent.fixedWorkspacePath,
      activity: activity ?? (status === "completed" ? "Result ready" : status === "approval" ? "Waiting for approval" : status),
      model: sessionRef.current.resolvedModel || (activeAgent.model === "default" ? "Codex default" : activeAgent.model),
      sandbox: activeAgent.sandbox,
      duration,
      startedAt: new Date(sessionRef.current.startedAt || Date.now()).toISOString(),
      finalResponse,
      threadId: sessionRef.current.threadId,
      conversation: settings.storeSelectedText ? conversation : conversation.filter((message) => message.id !== "selected-text"),
    };
    patch({ historySnapshot: run });
    return upsertRun(run, sessionRef.current.historyEpoch);
  }, [patch, sessionRef, settings.storeSelectedText, upsertRun]);

  const cancel = useEvent(() => terminate(true));
  const close = useEvent(() => terminate(false));

  const finish = useCallback(async (message: RpcMessage) => {
    if (!sessionRef.current.turnActive) return;
    patch({ turnActive: false });
    const completedEpoch = sessionRef.current.generation;
    const completedRunId = sessionRef.current.runId;
    const turn = asRecord(message.params?.turn);
    const status = asText(turn.status);
    const items = Array.isArray(turn.items) ? turn.items.map(asRecord) : [];
    const finalMessage = [...items].reverse().find((item) => item.type === "agentMessage");
    const finalText = asText(finalMessage?.text) || sessionRef.current.result;

    if (status === "failed") {
      const turnError = asRecord(turn.error);
      const detail = asText(turnError.message) || "The agent could not complete this run";
      setError(detail);
      setState("error");

      saveRun("failed", undefined, detail);
    } else if (status === "interrupted") {
      await saveRun("cancelled", undefined, "Cancelled");
      if (sessionRef.current.generation === completedEpoch) await close();
      return;
    } else {
      const completedText = finalText;
      if (!completedText) setError("The agent completed without a text response. The source text has not been changed.");
      setResult(completedText);
      const conversation = appendMessage({ id: `assistant-${Date.now()}`, role: "assistant", text: completedText });

      setState("result");

      await saveRun("completed", completedText, undefined, conversation);
      if (sessionRef.current.generation !== completedEpoch) return;
    }

    patch({ turnActive: false });
    patch({ starting: false });
    if (completedRunId && status === "failed") {
      void stopNativeRun(completedRunId).catch(() => undefined);
      patch({ runId: null });
    }
    // A completed result must stay alive even when the source application stops
    // exposing its selection. The user, rather than the selection monitor, owns
    // the result until they replace, close, cancel, or redirect it.
    await setOverlayPinned(true);
    if (status !== "failed" && sessionRef.current.result && sessionRef.current.activeAgent && sessionRef.current.selection && sessionRef.current.generation === completedEpoch) {
      await outputActionRef.current(sessionRef.current.activeAgent, sessionRef.current.selection, sessionRef.current.result);
    }
  }, [appendMessage, saveRun, patch, sessionRef, setResult, setState, close]);

  const handleMessage = useCallback((message: RpcMessage) => {
    const handleFailure = (detail: string) => {
      setError(detail); setState("error");
      saveRun("failed", undefined, detail);
      const id = sessionRef.current.runId;
      patch({ runId: null }); patch({ turnActive: false }); patch({ starting: false });
      if (id) void stopNativeRun(id).catch(() => undefined);
    };
    if (message.error) {
      const detail = message.error.message || "Codex app-server returned an error";
      setError(detail);
      setState("error");

      saveRun("failed", undefined, detail);
      const failedRunId = sessionRef.current.runId;
      patch({ runId: null });
      patch({ turnActive: false });
      patch({ starting: false });
      if (failedRunId) void stopNativeRun(failedRunId).catch(() => undefined);
      void setOverlayPinned(true).catch(() => undefined);
      return;
    }
    if (message.id === 1) {
      const response = asRecord(message.result);
      patch({ threadId: asText(asRecord(response.thread).id) || sessionRef.current.threadId });
      patch({ resolvedModel: asText(response.model) || sessionRef.current.resolvedModel });
    }
    if (message.method === "runtime/exited") {
      if (!sessionRef.current.turnActive && !sessionRef.current.starting) return;
      handleFailure("Codex stopped before the run completed");
      return;
    }
    if (message.method === "error") {
      const rpcError = asRecord(message.params?.error);
      setError(asText(rpcError.message) || "Codex app-server returned an error");
      return;
    }
    if (message.method === "item/agentMessage/delta") {
      const delta = asText(message.params?.delta);
      if (delta) {
        setResult(sessionRef.current.result + delta);
      }
      return;
    }
    if (message.method === "item/started" || message.method === "item/completed") {
      const item = asRecord(message.params?.item);
      if (item.type === "fileChange" && typeof item.id === "string" && Array.isArray(item.changes)) {
        const changes = item.changes.map(asRecord).map((change) => ({ path: asText(change.path), diff: asText(change.diff) }));
        patch({ fileChanges: { ...sessionRef.current.fileChanges, [item.id]: changes } });
      }
    }
    if (message.method === "item/completed") {
      const item = asRecord(message.params?.item);
      if (item.type === "agentMessage" && asText(item.text)) {
        setResult(asText(item.text));
      }
      return;
    }
    if (message.method === "turn/completed") {
      void finish(message);
      return;
    }
    const nextApproval = sessionRef.current.runId ? parseApproval(sessionRef.current.runId, message, sessionRef.current.fileChanges[asText(message.params?.itemId)]) : null;
    if (nextApproval) {
      dispatch({ type: "approval", generation: sessionRef.current.generation, approval: nextApproval });

      saveRun("approval", undefined, nextApproval.title);
    }
  }, [finish, saveRun, dispatch, patch, sessionRef, setResult, setState]);

  const receiveMessage = useEvent(handleMessage);
  const [runtimeEvents] = useState(() => new RuntimeEventAdapter(() => ({ runId: sessionRef.current.runId, starting: sessionRef.current.starting }), receiveMessage));

  useEffect(() => {
    if (!ready) return;
    let disposed = false;
    const unlistenSelection = listen<NativeSelection>("native-selection", ({ payload }) => {
      if (closing.current || !sessionRef.current.captureEnabled || sessionRef.current.turnActive || sessionRef.current.starting) return;
      clearAgentHover();
      const previousRunId = sessionRef.current.runId;
      if (previousRunId) void stopNativeRun(previousRunId).catch(() => undefined);
      patch({ runId: null });
      patch({ historyId: null });
      patch({ threadId: undefined });
      patch({ resolvedModel: "" });
      patch({ composerCapturedFocus: false });
      dispatch({ type: "reset", selection: payload });
      setReplacementStatus("");
      setSelection(payload);
      setAgentId(null);


      setState("idle");
      setShowAll(false);
      setInstructionOpen(false);
      setInstruction("");
      setError("");
      setResult("");
      setMessages([]);
      setCopied(false);
      setCopiedMessageId(null);
    });
    const unlistenRuntime = listen<RuntimeEvent>("codex-event", ({ payload }) => {
      runtimeEvents.receive(payload);
    });
    const unlistenPointer = listen<NativePointer>("context-pointer-position", ({ payload }) => {
      clearAgentHover();
      if (!payload.inside) return;
      const element = document.elementFromPoint?.(payload.x, payload.y);
      const button = element?.closest("button");
      setHoveredAgentId(button?.closest<HTMLElement>("[data-agent-id]")?.dataset.agentId ?? null);
      button?.classList.add("is-native-hovered");
      button?.closest(".context-agent-option")?.classList.add("is-native-hovered");
    });
    void Promise.all([unlistenSelection, unlistenRuntime, unlistenPointer])
      .then(async () => { if (!disposed) { await resizeContextBar(86, compactWidth); return markContextBarReady(); } })
      .catch(() => undefined);
    return () => {
      disposed = true;
      void unlistenSelection.then((unlisten) => unlisten());
      void unlistenRuntime.then((unlisten) => unlisten());
      void unlistenPointer.then((unlisten) => unlisten());
    };
  }, [ready, clearAgentHover, compactWidth, dispatch, patch, sessionRef, setMessages, setReplacementStatus, setResult, setSelection, setState, runtimeEvents]);

  const launchRun = async (runtimeAgent: CodexAgent, displayAgent: CodexAgent, source: NativeSelection, activity: string, runtimeSkills: CodexSkill[] = skills, runtimeMcps: McpServer[] = mcps) => {
    const launchEpoch = sessionRef.current.generation;
    patch({ historyId: `attempt-${randomUUID()}` });
    patch({ historyEpoch: resetEpoch });
    setApprovalError("");
    setApprovalPending(false);
    runtimeEvents.reset();
    setShowAll(false);
    setInstructionOpen(false);
    setAgentId(displayAgent.id);



    setResult("");
    const initialMessages: ConversationMessage[] = [{ id: "selected-text", role: "user", text: source.text }];
    setMessages(initialMessages);
    setCopied(false);
    setCopiedMessageId(null);
    setError("");
    patch({ approvals: [] });
    setState("running");
    patch({ startedAt: Date.now() });
    patch({ threadId: undefined });
    patch({ resolvedModel: "" });
    patch({ activeAgent: displayAgent });
    patch({ starting: true });
    patch({ turnActive: true });
    try {
      await saveRun("running", undefined, activity);
      if (sessionRef.current.generation !== launchEpoch) return;
      await setOverlayPinned(true);
      const response = await startNativeRun(runtimeAgent, {
        selection: source.text,
        application: source.application,
        windowTitle: !settings.redactWindowTitles && displayAgent.contextPolicy.includeWindowTitle ? source.windowTitle : undefined,
        workspace: runtimeAgent.fixedWorkspacePath,
      }, runtimeSkills, runtimeMcps);
      if (sessionRef.current.generation !== launchEpoch) { await stopNativeRun(response.runId); return; }
      patch({ runId: response.runId });
      saveRun("running", undefined, activity);
      runtimeEvents.started(response.runId);
    } catch (caught) {
      if (sessionRef.current.generation !== launchEpoch) return;
      const detail = caught instanceof Error ? caught.message : String(caught);
      setError(detail);
      setState("error");

      await saveRun("failed", undefined, detail);
      patch({ runId: null });
      patch({ turnActive: false });
      await setOverlayPinned(true);
    } finally {
      if (sessionRef.current.generation === launchEpoch) patch({ starting: false });
    }
  };

  const start = async (target: CodexAgent, requestEpoch: number) => {
    const source = sessionRef.current.selection ?? selection;
    if (!ready || !settings.contextBarEnabled || !source || sessionRef.current.starting) return;
    patch({ composerCapturedFocus: false });
    if (target.contextPolicy.excludedApplications.some((application) => application.toLowerCase() === source.application.toLowerCase())) {
      throw new Error(`${target.name} excludes ${source.application}`);
    }
    let workspace: string | undefined;
    if (target.workspaceMode === "fixed") {
      workspace = target.fixedWorkspacePath?.trim();
      if (!workspace) throw new Error("Choose a fixed workspace in the agent settings first");
    } else if (target.workspaceMode === "recent-project") {
      workspace = recentWorkspace;
      if (!workspace) throw new Error("No recent workspace is available. Add a workspace in Studio.");
    } else if (target.workspaceMode === "ask-each-time" || target.workspaceMode === "active-application") {
      // Arbitrary apps do not expose a trustworthy filesystem working directory.
      const selected = await chooseWorkspaceFolder();
      if (!selected) { await setOverlayPinned(false); return; }
      workspace = selected;
      await focusSelectionApplication(source.processId);
    }
    const runtimeAgent: CodexAgent = workspace
      ? { ...target, workspaceMode: "fixed", fixedWorkspacePath: workspace }
      : { ...target, workspaceMode: "none", fixedWorkspacePath: undefined };
    const environment = await refreshCodexEnvironment(workspace, target.codexProfile);
    if (sessionRef.current.generation !== requestEpoch) return;
    if (!environment) throw new Error("Could not load the Codex environment for this workspace/profile. Refresh it in Studio and try again.");
    const validated = validateRuntimeAgent(runtimeAgent, environment);
    await migrateAgentSkills(target.id, target.enabledSkills, environment.skills, target);
    if (sessionRef.current.generation !== requestEpoch) return;
    await launchRun(validated, validated, source, "The agent is working", environment.skills, environment.mcpServers);

  };

  const chooseAgent = async (target: CodexAgent) => {
    if (launchingAgentId || sessionRef.current.starting) return;
    const requestEpoch = sessionRef.current.generation;
    setLaunchingAgentId(target.id);
    try {
      await setOverlayPinned(true);
      const source = sessionRef.current.selection ?? selection;
      if (source) await focusSelectionApplication(source.processId).catch(() => undefined);
      await wait(130);
      if (sessionRef.current.generation === requestEpoch) await start(target, requestEpoch);
    } catch (caught) {
      if (sessionRef.current.generation !== requestEpoch) return;
      const detail = caught instanceof Error ? caught.message : String(caught);
      patch({ historyId: `attempt-${randomUUID()}` });
      patch({ historyEpoch: resetEpoch });
      patch({ activeAgent: target });
      patch({ startedAt: Date.now() });
      patch({ threadId: undefined });
      setMessages([]);
      await saveRun("failed", undefined, detail);
      setError(detail);
      setState("error");
    } finally {
      if (sessionRef.current.generation === requestEpoch) setLaunchingAgentId(null);
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

  const deliverToStudio = async () => {
    const generation = sessionRef.current.generation;
    try {
      if (!sessionRef.current.historySnapshot) throw new Error("The result is not ready to open in Studio");
      await handoffResult(sessionRef.current.historySnapshot, sessionRef.current.historyEpoch, () => sessionRef.current.generation === generation);
      if (sessionRef.current.generation === generation) { setHandoffFailed(false); await close(); }
    } catch (error) {
      if (sessionRef.current.generation === generation) { setHandoffFailed(true); setError(String(error)); }
    }
  };
  const redirectToStudio = async () => {
    if (sessionRef.current.state === "result") { await deliverToStudio(); return; }
    await close(); await openStudio();
  };

  const openContinuation = async () => {
    if (state !== "result") return;
    patch({ composerCapturedFocus: true });
    setInstructionOpen(true);
    await setOverlayPinned(true);
    await setContextBarFocusable(true);
  };

  const closeContinuation = async () => {
    const source = sessionRef.current.selection;
    setInstructionOpen(false);
    setInstruction("");
    patch({ composerCapturedFocus: false });
    await setContextBarFocusable(false).catch(() => undefined);
    if (source) await focusSelectionApplication(source.processId).catch(() => undefined);
    await setOverlayPinned(true);
  };

  const continueRun = async (event: FormEvent) => {
    event.preventDefault();
    const followUp = instruction.trim();
    const source = sessionRef.current.selection;
    const baseAgent = sessionRef.current.activeAgent;
    const id = sessionRef.current.runId;
    if (!followUp || !source || !baseAgent || !id || sessionRef.current.starting || sessionRef.current.state !== "result") return;
    dispatch({ type: "invalidate" });
    const generation = sessionRef.current.generation;
    appendMessage({ id: `user-${Date.now()}`, role: "user", text: followUp });
    setInstruction("");
    setInstructionOpen(false);
    setResult("");
    setCopied(false);


    setState("running");
    patch({ composerCapturedFocus: false });
    patch({ starting: true });
    patch({ turnActive: true });
    await setContextBarFocusable(false).catch(() => undefined);
    await focusSelectionApplication(source.processId).catch(() => undefined);
    try {
      if (sessionRef.current.generation !== generation) return;
      await continueNativeRun(id, followUp);
      if (sessionRef.current.generation !== generation || !sessionRef.current.turnActive) return;
      saveRun("running", undefined, "Applying follow-up instructions");
    } catch (caught) {
      if (sessionRef.current.generation !== generation || !sessionRef.current.turnActive) return;
      const detail = caught instanceof Error ? caught.message : String(caught);
      setError(detail);
      setState("error");

      patch({ turnActive: false });
      saveRun("failed", undefined, detail);
    } finally {
      if (sessionRef.current.generation === generation) patch({ starting: false });
    }
  };

  const answerApproval = async (allow: boolean) => {
    if (!approval || !sessionRef.current.runId || sessionRef.current.approvalInFlight) return;
    const approvalEpoch = sessionRef.current.generation;
    const id = sessionRef.current.runId;
    setApprovalPending(true); setApprovalError("");
    const response = approvalResponse(approval, allow);
    try {
      await respondToApproval(id, approval.requestId, response);
      if (sessionRef.current.generation !== approvalEpoch || sessionRef.current.runId !== id || !sessionRef.current.turnActive) return;
      dispatch({ type: "answered", generation: approvalEpoch, key: approval.key });

      void saveRun(sessionRef.current.approvals.length ? "approval" : "running", undefined, "Approval delivered");
    } catch (caught) {
      if (sessionRef.current.generation === approvalEpoch) setApprovalError(`Could not deliver approval: ${caught instanceof Error ? caught.message : String(caught)}. Try again or cancel.`);
    } finally {
        if (sessionRef.current.generation === approvalEpoch) setApprovalPending(false);
    }
  };

  const closing = useRef<Promise<void> | null>(null);
  const terminate = (interrupt: boolean) => {
    if (closing.current) return closing.current;
    clearAgentHover();
    dispatch({ type: "invalidate" });
    const id = sessionRef.current.runId;
    const wasActive = sessionRef.current.turnActive || sessionRef.current.starting;
    const saved = wasActive ? saveRun("cancelled", undefined, "Cancelled") : Promise.resolve();
    patch({ turnActive: false }); patch({ starting: false });
    patch({ runId: null, approvals: [] });
    const operation = async () => {
      if (id) {
        if (interrupt) await interruptNativeRun(id).catch(() => undefined);
        await stopNativeRun(id).catch(() => undefined);
      }
      await saved;
      patch({ historyId: null }); patch({ activeAgent: null });
      patch({ composerCapturedFocus: false });
      dispatch({ type: "reset" });

      await setContextBarFocusable(false).catch(() => undefined);
      await setOverlayPinned(false);
      await hideContextBar();
    };
    closing.current = operation().finally(() => { closing.current = null; });
    return closing.current;
  };

  useEffect(() => {
    if (!ready) return;
    const reset = sessionRef.current.observedEpoch && sessionRef.current.observedEpoch !== resetEpoch;
    patch({ observedEpoch: resetEpoch });
    if (reset) {
      // Invalidate pending launches and output actions before any asynchronous cleanup.
      dispatch({ type: "invalidate" });
      patch({ historyId: null });
      void close();
    } else if (!settings.contextBarEnabled && (sessionRef.current.selection || sessionRef.current.starting)) {
      void cancel();
    }
  }, [ready, resetEpoch, settings.contextBarEnabled, cancel, close, dispatch, sessionRef, patch]);

  const applyReplacement = async (source: NativeSelection, text: string) => {
    const replacementEpoch = sessionRef.current.generation;
    setReplacing(true);
    setError("");
    try {
      await setContextBarFocusable(false);
      await focusSelectionApplication(source.processId);
      await wait(130);
      if (sessionRef.current.generation !== replacementEpoch) return;
      const outcome = await replaceNativeSelection(text, source.selectionId);
      if (sessionRef.current.generation !== replacementEpoch) return;
      if (outcome.verified) await close();
      else setReplacementStatus("Replacement sent, but the editor could not confirm it. Check the source before pasting again. You can still copy the answer here.");
    } catch (caught) {
      if (sessionRef.current.generation !== replacementEpoch) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally { if (sessionRef.current.generation === replacementEpoch) setReplacing(false); }
  };

  const replace = async () => {
    const source = sessionRef.current.selection;
    if (replacing || replacementStatus || state !== "result" || !sessionRef.current.result || !agent?.outputPolicy.allowReplace || !source || source.replacementCapability === "none") return;
    await applyReplacement(source, sessionRef.current.result);
  };

  outputActionRef.current = async (activeAgent, source, text) => {
    const actionGeneration = sessionRef.current.generation;
    try {
      await performOutputAction(activeAgent, source, text, !!sessionRef.current.replacementStatus, {
        copy: async (text) => { await copyNativeText(text); if (sessionRef.current.generation === actionGeneration) setCopied(true); },
        studio: deliverToStudio, replace: applyReplacement, explain: setError,
      });
    } catch (caught) {
      if (sessionRef.current.generation !== actionGeneration) return;
      setHandoffFailed(activeAgent.outputPolicy.mode === "open-studio");
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const copyMessage = async (message: ConversationMessage) => {
    const generation = sessionRef.current.generation;
    try { await copyNativeText(message.text); if (sessionRef.current.generation === generation) setCopiedMessageId(message.id); }
    catch (caught) { if (sessionRef.current.generation === generation) setError(caught instanceof Error ? caught.message : String(caught)); }
  };

  const agentButton = (item: CodexAgent, picker = false) => {
    const active = hoveredAgentId === item.id;
    const launching = launchingAgentId === item.id;
    const className = `${picker ? "context-agent-option" : "context-action"}${active ? " is-hovered" : ""}${launching ? " is-launching" : ""}`;
    if (picker) return <div
      className={className}
      data-agent-id={item.id}
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
      data-agent-id={item.id}
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

  if (!ready || !selection) return null;
  if (updating) return <div className="context-wrap context-native"><div className="context-bar context-updating" role="status">Latch Bar is updating. Please wait for it to restart.</div></div>;
  const running = state === "running";
  const completed = state === "result";
  const replacementDisabledReason = agent && !agent.outputPolicy.allowReplace
    ? `Replacement is disabled for ${agent.name}`
    : selection.replacementCapability !== "accessibility" && selection.replacementCapability !== "clipboardPaste"
      ? selection.replacementUnavailableReason || "The selected text is read-only"
      : undefined;
  const sourceAllowsReplacement = selection.replacementCapability === "accessibility" || selection.replacementCapability === "clipboardPaste";
  const canReplace = Boolean(completed && result && agent?.outputPolicy.allowReplace && sourceAllowsReplacement && !replacing && !replacementStatus);

  return <div className={`context-wrap context-native state-${state}${showAll ? " picker-open" : ""}`}>
    <div className="context-bar" role="region" aria-label="Latch Context Bar">
      <div className="context-state" key={`${selection.selectionId}-${state}-${showAll ? "picker" : "bar"}`}>
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
            <div className="context-run-copy"><strong>{agent.name}</strong><small>{agent.sandbox === "full-access" && <strong className="context-access-warning">Full computer access · </strong>}{running ? "Streaming response in Latch" : "Answer ready in Latch"}</small></div>
            <div className="context-run-actions">
              <button type="button" className="result-button" disabled={!completed} onClick={() => void openContinuation()}><MessageCircle size={14} /> Continue</button>
              {running && <button type="button" className="result-button danger" onClick={() => void cancel()}><Square size={12} fill="currentColor" /> Cancel</button>}
              <button type="button" className="result-button primary" disabled={!canReplace} title={replacementDisabledReason} onClick={() => void replace()}><Replace size={14} /> Replace</button>
              <button type="button" className="context-copy" disabled={!result} onClick={async () => { try { await copyNativeText(result); setCopied(true); } catch (caught) { setError(String(caught)); } }} aria-label="Copy response"><Copy size={15} /><span>{copied ? "Copied" : "Copy"}</span></button>
              <button type="button" className="context-redirect" onClick={() => void redirectToStudio()} aria-label="Open in Studio"><ArrowUpRight size={16} /></button>
              {completed && <button type="button" className="context-cancel" onClick={() => void close()} aria-label="Close"><X size={14} /></button>}
            </div>
          </header>
          {completed && (error || replacementStatus) && <div className="context-replacement-status" role="status">{error || replacementStatus}{handoffFailed && agent && <button onClick={() => void deliverToStudio()}>Retry opening Studio</button>}</div>}
          {running && <div className="context-stream-progress"><i /></div>}
          <Conversation answerRef={answerRef} running={running} messages={messages} agentName={agent.name} streamPreview={agent.outputPolicy.streamPreview} result={result} copiedMessageId={copiedMessageId} onCopy={copyMessage} />
          {instructionOpen && <form className="context-follow-up" onSubmit={(event) => void continueRun(event)}>
            <MessageCircle size={15} />
            <input ref={instructionRef} aria-label="Additional instructions" value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="Add instructions for the next response…" />
            <button type="submit" disabled={!instruction.trim()}><Send size={14} /> Continue</button>
            <button type="button" aria-label="Cancel additional instructions" onClick={() => void closeContinuation()}><X size={14} /></button>
          </form>}
        </div>}

        {state === "approval" && approval && <div className="context-run-view">
          <header className="context-run-header"><span className="approval-icon"><ShieldAlert size={18} /></span><div className="context-run-copy"><strong>{approval.title}</strong>{approvalError && <span role="alert">{approvalError}</span>}<small>{agent?.sandbox === "full-access" && <strong className="context-access-warning">Full computer access · </strong>}Your agent needs your approval to continue here</small></div></header>
          <ApprovalDetails approval={approval} count={session.approvals.length} />
          <div className="context-run-actions"><button type="button" className="allow-button" disabled={approvalPending || !approval.supported} onClick={() => void answerApproval(true)}>{approval.allowLabel}</button><button type="button" className="deny-button" disabled={approvalPending} onClick={() => void answerApproval(false)}>Deny</button><button type="button" className="context-redirect" onClick={() => void redirectToStudio()} aria-label="Open in Studio"><ArrowUpRight size={16} /></button><button type="button" className="context-cancel" onClick={() => void cancel()} aria-label="Cancel"><X size={14} /></button></div>
        </div>}

        {state === "error" && <div className="context-run-view">
          <header className="context-run-header"><span className="error-icon"><X size={17} /></span><div className="context-run-copy"><strong>Run failed</strong><small>The error is shown below</small></div><div className="context-run-actions">{result && <button type="button" className="result-button" onClick={() => void copyNativeText(result)}><Copy size={14} /> Copy partial</button>}<button type="button" className="context-redirect" onClick={() => void redirectToStudio()} aria-label="Open in Studio"><ArrowUpRight size={16} /></button><button type="button" className="context-cancel" onClick={() => void close()} aria-label="Close"><X size={14} /></button></div></header>
          <div className="context-error-detail">{error}</div>
        </div>}
      </div>
    </div>
  </div>;
}
