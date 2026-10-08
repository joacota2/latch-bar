import type { CodexAgent, Run, ConversationMessage, NativeSelection } from "../domain";
import type { Approval } from "./approvals";
export type BarState = "idle" | "running" | "approval" | "result" | "error";
export interface ContextSession {
  generation: number; runId: string | null; selection: NativeSelection | null;
  state: BarState; result: string; messages: ConversationMessage[]; approvals: Approval[]; seenApprovals: string[];
  replacementStatus: string; replacing: boolean;
  historyId: string | null; historySnapshot: Run | null; historyEpoch: string;
  observedEpoch: string; captureEnabled: boolean; approvalInFlight: boolean;
  turnActive: boolean; starting: boolean; startedAt: number; threadId: string | undefined;
  fileChanges: Record<string, { path: string; diff: string }[]>;
  resolvedModel: string; activeAgent: CodexAgent | null; composerCapturedFocus: boolean; launchingAgentId: string | null;
}
export const initialSession: ContextSession = { generation: 0, runId: null, selection: null, state: "idle", result: "", messages: [], approvals: [], seenApprovals: [], replacementStatus: "", replacing: false,
  historyId: null, historySnapshot: null, historyEpoch: "", observedEpoch: "", captureEnabled: false, approvalInFlight: false,
  turnActive: false, starting: false, startedAt: 0, threadId: undefined, fileChanges: {}, resolvedModel: "", activeAgent: null, composerCapturedFocus: false, launchingAgentId: null };
export type SessionAction =
  | { type: "invalidate" }
  | { type: "reset"; selection?: NativeSelection | null }
  | { type: "patch"; generation: number; runId?: string | null; patch: Partial<Omit<ContextSession, "generation">> }
  | { type: "approval"; generation: number; approval: Approval }
  | { type: "answered"; generation: number; key: string };
export function contextSessionReducer(state: ContextSession, action: SessionAction): ContextSession {
  if (action.type === "invalidate") return { ...state, generation: state.generation + 1, approvals: [] };
  if (action.type === "reset") return { ...initialSession, generation: state.generation + 1, selection: action.selection ?? null, captureEnabled: state.captureEnabled, observedEpoch: state.observedEpoch };
  if (action.generation !== state.generation) return state;
  if (action.type === "patch") {
    if (action.runId !== undefined && action.runId !== state.runId) return state;
    const next = { ...state, ...action.patch };
    if (next.state === "error" || next.state === "result" || next.state === "idle") next.approvals = [];
    return next;
  }
  if (action.type === "approval") {
    if (action.approval.runId !== state.runId || state.seenApprovals.includes(action.approval.key)) return state;
    return { ...state, state: "approval", approvals: [...state.approvals, action.approval], seenApprovals: [...state.seenApprovals, action.approval.key] };
  }
  if (!state.approvals.some((approval) => approval.key === action.key)) return state;
  const approvals = state.approvals.filter((item) => item.key !== action.key);
  return { ...state, approvals, state: approvals.length ? "approval" : "running" };
}
