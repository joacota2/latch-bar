import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LatchProvider, useLatch } from "./LatchStore";
import { seedAgents, seedSettings } from "../data/seed";
import type { Run } from "../domain";
vi.mock("../services/runtime", () => ({ isTauri: () => false, scanCodexEnvironment: vi.fn() }));
const key = "latch-bar-state-v1";
const run: Run = { id: "test", agentId: "agent", agentName: "Test", agentIcon: "T", status: "completed", sourceApplication: "Editor", sourceIcon: "E", activity: "Done", model: "default", sandbox: "read-only", startedAt: "today", finalResponse: "Answer", conversation: [{ id: "selected-text", role: "user", text: "secret" }, { id: "answer", role: "assistant", text: "Answer" }] };
beforeEach(() => localStorage.clear());
afterEach(cleanup);
describe("persisted state", () => {
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
