import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LatchProvider, useLatch } from "./LatchStore";
import { DEFAULT_AGENTS_VERSION, seedAgents, seedSettings } from "../data/seed";
import type { Run } from "../domain";
vi.mock("../services/runtime", () => ({ isTauri: () => false, scanCodexEnvironment: vi.fn() }));
const key = "latch-bar-state-v1";
const run: Run = { id: "test", agentId: "agent", agentName: "Test", agentIcon: "T", status: "completed", sourceApplication: "Editor", sourceIcon: "E", activity: "Done", model: "default", sandbox: "read-only", startedAt: "today", finalResponse: "Answer", conversation: [{ id: "selected-text", role: "user", text: "secret" }, { id: "answer", role: "assistant", text: "Answer" }] };
beforeEach(() => localStorage.clear());
afterEach(cleanup);
describe("persisted state", () => {
  it("starts with the five everyday agents and three pinned actions", () => {
    const { result } = renderHook(useLatch, { wrapper: LatchProvider });
    expect(result.current.agents.map((agent) => agent.name)).toEqual([
      "Improve writing", "Summarize", "Explain simply", "Translate to English", "Draft a reply",
    ]);
    expect(result.current.agents.filter((agent) => agent.pinned).map((agent) => agent.id)).toEqual([
      "improve-writing", "summarize", "explain-simply",
    ]);
  });

  it("replaces retired default IDs while preserving custom agents, preferences, and history", () => {
    const writing = { ...seedAgents[0], name: "My writing", pinned: false, enabled: false, promptTemplate: "Keep my voice." };
    const translate = seedAgents.find((agent) => agent.id === "translate")!;
    const custom = { ...seedAgents[0], id: "custom-engineer", name: "Staff engineer", order: 10 };
    const retired = ["staff-engineer", "ui-reviewer", "explain-error", "plan-implementation"].map((id) => ({ ...seedAgents[0], id }));
    localStorage.setItem(key, JSON.stringify({
      agents: [writing, ...retired, translate, custom], runs: [run],
      settings: { ...seedSettings, minimumCharacters: 12 }, savedWorkspaces: [{ path: "/projects/demo", name: "Demo" }],
    }));
    const { result } = renderHook(useLatch, { wrapper: LatchProvider });
    expect(result.current.agents.map((agent) => agent.id)).toEqual([
      "improve-writing", "translate", "custom-engineer", "summarize", "explain-simply", "draft-reply",
    ]);
    expect(result.current.agents.slice(0, 3)).toEqual([writing, translate, custom]);
    expect(result.current.agents.slice(3).map((agent) => agent.order)).toEqual([11, 12, 13]);
    expect(result.current.runs).toEqual([run]);
    expect(result.current.settings.minimumCharacters).toBe(12);
    expect(result.current.workspaces[0].path).toBe("/projects/demo");
  });

  it("does not duplicate new agents or restore deleted defaults after migration and remount", () => {
    const summary = { ...seedAgents.find((agent) => agent.id === "summarize")!, promptTemplate: "My summary style." };
    localStorage.setItem(key, JSON.stringify({ agents: [summary], settings: seedSettings, runs: [] }));
    const first = renderHook(useLatch, { wrapper: LatchProvider });
    expect(first.result.current.agents.filter((agent) => agent.id === "summarize")).toEqual([summary]);
    expect(first.result.current.agents.some((agent) => agent.id === "improve-writing" || agent.id === "translate")).toBe(false);
    act(() => first.result.current.deleteAgent("summarize"));
    expect(JSON.parse(localStorage.getItem(key)!).defaultAgentsVersion).toBe(DEFAULT_AGENTS_VERSION);
    first.unmount();
    const next = renderHook(useLatch, { wrapper: LatchProvider });
    expect(next.result.current.agents.map((agent) => agent.id)).toEqual(["explain-simply", "draft-reply"]);
    act(() => next.result.current.deleteAgent("explain-simply"));
    act(() => next.result.current.deleteAgent("draft-reply"));
    next.unmount();
    const empty = renderHook(useLatch, { wrapper: LatchProvider });
    expect(empty.result.current.agents).toEqual([]);
  });

  it("does not write runs when history is disabled and purges existing history", () => {
    const { result } = renderHook(useLatch, { wrapper: LatchProvider });
    act(() => result.current.upsertRun(run));
    expect(JSON.parse(localStorage.getItem(key)!).runs[0].conversation).toHaveLength(1);
    act(() => result.current.updateSettings({ storeHistory: false }));
    act(() => result.current.upsertRun(run));
    expect(result.current.runs).toEqual([]);
    expect(JSON.parse(localStorage.getItem(key)!).runs).toEqual([]);
  });
  it("merges a run update with the latest settings and agents from another window", () => {
    const { result } = renderHook(useLatch, { wrapper: LatchProvider });
    localStorage.setItem(key, JSON.stringify({ agents: [{ ...seedAgents[0], name: "Changed elsewhere" }], settings: { ...seedSettings, minimumCharacters: 20 }, runs: [] }));
    act(() => result.current.upsertRun(run));
    const persisted = JSON.parse(localStorage.getItem(key)!);
    expect(persisted.agents[0].name).toBe("Changed elsewhere");
    expect(persisted.settings.minimumCharacters).toBe(20);
  });
  it("deduplicates saved folders and keeps them across remounts", () => {
    const first = renderHook(useLatch, { wrapper: LatchProvider });
    act(() => { first.result.current.addWorkspace("/projects/demo/"); first.result.current.addWorkspace("/projects/demo"); });
    expect(first.result.current.workspaces).toHaveLength(1);
    first.unmount();
    const next = renderHook(useLatch, { wrapper: LatchProvider });
    expect(next.result.current.workspaces[0].path).toBe("/projects/demo");
  });
});
