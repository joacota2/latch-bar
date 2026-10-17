import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LatchProvider, useLatch } from "./LatchStore";
import { DEFAULT_AGENTS_VERSION, seedAgents, seedSettings } from "../data/seed";
import type { Run } from "../domain";
vi.mock("../services/runtime", () => ({
  isTauri: () => false,
  scanCodexEnvironment: vi.fn(),
}));
const key = "latch-bar-state-v1";
const run: Run = {
  id: "test",
  agentId: "agent",
  agentName: "Test",
  agentIcon: "T",
  status: "completed",
  sourceApplication: "Editor",
  sourceIcon: "E",
  activity: "Done",
  model: "default",
  sandbox: "read-only",
  startedAt: "today",
  finalResponse: "Answer",
  conversation: [
    { id: "selected-text", role: "user", text: "secret" },
    { id: "answer", role: "assistant", text: "Answer" },
  ],
};
beforeEach(() => localStorage.clear());
afterEach(cleanup);
describe("persisted state", async () => {
  it("starts with the five everyday agents and three pinned actions", async () => {
    const { result } = renderHook(useLatch, { wrapper: LatchProvider });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.agents.map((agent) => agent.name)).toEqual([
      "Improve writing",
      "Summarize",
      "Explain simply",
      "Translate to English",
      "Draft a reply",
    ]);
    expect(
      result.current.agents
        .filter((agent) => agent.pinned)
        .map((agent) => agent.id),
    ).toEqual(["improve-writing", "summarize", "explain-simply"]);
  });

  it("replaces retired default IDs while preserving custom agents, preferences, and history", async () => {
    const writing = {
      ...seedAgents[0],
      name: "My writing",
      pinned: false,
      enabled: false,
      promptTemplate: "Keep my voice.",
    };
    const translate = seedAgents.find((agent) => agent.id === "translate")!;
    const custom = {
      ...seedAgents[0],
      id: "custom-engineer",
      name: "Staff engineer",
      order: 10,
    };
    const retired = [
      "staff-engineer",
      "ui-reviewer",
      "explain-error",
      "plan-implementation",
    ].map((id) => ({ ...seedAgents[0], id }));
    localStorage.setItem(
      key,
      JSON.stringify({
        agents: [writing, ...retired, translate, custom],
        runs: [run],
        settings: { ...seedSettings, minimumCharacters: 12 },
        savedWorkspaces: [{ path: "/projects/demo", name: "Demo" }],
      }),
    );
    const { result } = renderHook(useLatch, { wrapper: LatchProvider });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.agents.map((agent) => agent.id)).toEqual([
      "improve-writing",
      "translate",
      "custom-engineer",
      "summarize",
      "explain-simply",
      "draft-reply",
    ]);
    expect(result.current.agents.slice(0, 3)).toEqual([
      writing,
      translate,
      custom,
    ]);
    expect(result.current.agents.slice(3).map((agent) => agent.order)).toEqual([
      11, 12, 13,
    ]);
    expect(result.current.runs).toEqual([run]);
    expect(result.current.settings.minimumCharacters).toBe(12);
    expect(result.current.workspaces[0].path).toBe("/projects/demo");
  });

  it("does not duplicate new agents or restore deleted defaults after migration and remount", async () => {
    const summary = {
      ...seedAgents.find((agent) => agent.id === "summarize")!,
      promptTemplate: "My summary style.",
    };
    localStorage.setItem(
      key,
      JSON.stringify({ agents: [summary], settings: seedSettings, runs: [] }),
    );
    const first = renderHook(useLatch, { wrapper: LatchProvider });
    await waitFor(() => expect(first.result.current.ready).toBe(true));
    expect(
      first.result.current.agents.filter((agent) => agent.id === "summarize"),
    ).toEqual([summary]);
    expect(
      first.result.current.agents.some(
        (agent) => agent.id === "improve-writing" || agent.id === "translate",
      ),
    ).toBe(false);
    await act(async () => first.result.current.deleteAgent("summarize"));
    expect(JSON.parse(localStorage.getItem(key)!).defaultAgentsVersion).toBe(
      DEFAULT_AGENTS_VERSION,
    );
    first.unmount();
    const next = renderHook(useLatch, { wrapper: LatchProvider });
    await waitFor(() => expect(next.result.current.ready).toBe(true));
    expect(next.result.current.agents.map((agent) => agent.id)).toEqual([
      "explain-simply",
      "draft-reply",
    ]);
    await act(async () => next.result.current.deleteAgent("explain-simply"));
    await act(async () => next.result.current.deleteAgent("draft-reply"));
    next.unmount();
    const empty = renderHook(useLatch, { wrapper: LatchProvider });
    await waitFor(() => expect(empty.result.current.ready).toBe(true));
    expect(empty.result.current.agents).toEqual([]);
  });

  it("does not write runs when history is disabled and purges existing history", async () => {
    const { result } = renderHook(useLatch, { wrapper: LatchProvider });
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => result.current.upsertRun(run));
    expect(
      JSON.parse(localStorage.getItem(key)!).runs[0].conversation,
    ).toHaveLength(1);
    await act(async () =>
      result.current.updateSettings({ storeHistory: false }),
    );
    await act(async () => result.current.upsertRun(run));
    expect(result.current.runs).toEqual([]);
    expect(JSON.parse(localStorage.getItem(key)!).runs).toEqual([]);
  });
  it("merges a run update with the latest settings and agents from another window", async () => {
    const { result } = renderHook(useLatch, { wrapper: LatchProvider });
    await waitFor(() => expect(result.current.ready).toBe(true));
    localStorage.setItem(
      key,
      JSON.stringify({
        agents: [{ ...seedAgents[0], name: "Changed elsewhere" }],
        settings: { ...seedSettings, minimumCharacters: 20 },
        runs: [],
      }),
    );
    await act(async () => result.current.upsertRun(run));
    const persisted = JSON.parse(localStorage.getItem(key)!);
    expect(persisted.agents[0].name).toBe("Changed elsewhere");
    expect(persisted.settings.minimumCharacters).toBe(20);
  });
  it("deduplicates saved folders and keeps them across remounts", async () => {
    const first = renderHook(useLatch, { wrapper: LatchProvider });
    await waitFor(() => expect(first.result.current.ready).toBe(true));
    await act(async () => {
      await first.result.current.addWorkspace("/projects/demo/");
      await first.result.current.addWorkspace("/projects/demo");
    });
    expect(first.result.current.workspaces).toHaveLength(1);
    first.unmount();
    const next = renderHook(useLatch, { wrapper: LatchProvider });
    await waitFor(() => expect(next.result.current.ready).toBe(true));
    expect(next.result.current.workspaces[0].path).toBe("/projects/demo");
  });
});

describe("cross-window persistence regressions", () => {
  afterEach(() => vi.restoreAllMocks());

  it("GAP-06 reset reaches another mounted window and rejects its old run callback", async () => {
    const studio = renderHook(useLatch, { wrapper: LatchProvider });
    const bar = renderHook(useLatch, { wrapper: LatchProvider });
    await waitFor(() =>
      expect(studio.result.current.ready && bar.result.current.ready).toBe(
        true,
      ),
    );
    const oldEpoch = bar.result.current.resetEpoch;
    await act(async () => {
      await bar.result.current.upsertRun(run, oldEpoch);
    });
    await waitFor(() => expect(studio.result.current.runs).toHaveLength(1));
    await act(async () => {
      await studio.result.current.clearData();
    });
    await waitFor(() => expect(bar.result.current.runs).toEqual([]));
    await act(async () => {
      expect(await bar.result.current.upsertRun(run, oldEpoch)).toBe(false);
    });
    expect(JSON.parse(localStorage.getItem(key)!).runs).toEqual([]);
  });

  it("GAP-06 key removal reloads default state in an already-open browser", async () => {
    localStorage.setItem(key, JSON.stringify({ runs: [run] }));
    const view = renderHook(useLatch, { wrapper: LatchProvider });
    await waitFor(() => expect(view.result.current.runs).toHaveLength(1));
    await act(async () => {
      localStorage.removeItem(key);
      window.dispatchEvent(
        new StorageEvent("storage", { key, newValue: null }),
      );
    });
    expect(view.result.current.runs).toEqual([]);
  });

  it("GAP-07 simultaneous writes from independent providers preserve both changes", async () => {
    const studio = renderHook(useLatch, { wrapper: LatchProvider });
    const bar = renderHook(useLatch, { wrapper: LatchProvider });
    await waitFor(() =>
      expect(studio.result.current.ready && bar.result.current.ready).toBe(
        true,
      ),
    );
    await act(async () => {
      await Promise.all([
        studio.result.current.updateSettings({ minimumCharacters: 17 }),
        bar.result.current.upsertRun(run),
      ]);
    });
    const state = JSON.parse(localStorage.getItem(key)!);
    expect(state.settings.minimumCharacters).toBe(17);
    expect(state.runs[0].id).toBe(run.id);
    await waitFor(() => expect(studio.result.current.runs).toHaveLength(1));
    expect(bar.result.current.settings.minimumCharacters).toBe(17);
  });

  it("GAP-08 rejects malformed saved fields without crashing valid data", async () => {
    localStorage.setItem(
      key,
      JSON.stringify({
        agents: [null, { ...seedAgents[0], name: 42 }, seedAgents[1]],
        runs: [
          null,
          { ...run, status: "bogus" },
          { ...run, conversation: [{}] },
          run,
        ],
        savedWorkspaces: [null, { path: 4 }, { path: "/safe", name: {} }],
        settings: {
          ...seedSettings,
          minimumCharacters: "bad",
          excludedApplications: [null],
        },
      }),
    );
    const view = renderHook(useLatch, { wrapper: LatchProvider });
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    expect(view.result.current.runs).toEqual([run]);
    expect(
      view.result.current.agents.every(
        (agent) => typeof agent.name === "string",
      ),
    ).toBe(true);
    expect(view.result.current.workspaces[0].name).toBe("safe");
    expect(view.result.current.settings.minimumCharacters).toBe(
      seedSettings.minimumCharacters,
    );
  });

  it("GAP-08 failed writes retain last good state and expose a retryable error", async () => {
    const view = renderHook(useLatch, { wrapper: LatchProvider });
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    await act(async () => {
      await view.result.current.updateSettings({ minimumCharacters: 7 });
    });
    const before = localStorage.getItem(key);
    const failure = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      });
    await act(async () => {
      expect(
        await view.result.current.updateSettings({ minimumCharacters: 15 }),
      ).toBe(false);
    });
    expect(view.result.current.settings.minimumCharacters).toBe(7);
    expect(localStorage.getItem(key)).toBe(before);
    expect(view.result.current.persistenceError).toContain("Quota exceeded");
    failure.mockRestore();
    await act(async () => {
      expect(
        await view.result.current.updateSettings({ minimumCharacters: 15 }),
      ).toBe(true);
    });
    expect(view.result.current.persistenceError).toBe("");
  });
});

it("GAP-11 pause commits cancellation before a late runtime error can arrive", async () => {
  const view = renderHook(useLatch, { wrapper: LatchProvider });
  await waitFor(() => expect(view.result.current.ready).toBe(true));
  await act(async () => {
    await view.result.current.upsertRun({ ...run, status: "approval" });
  });
  await act(async () => {
    await view.result.current.updateSettings({ contextBarEnabled: false });
  });
  await act(async () => {
    await view.result.current.upsertRun({
      ...run,
      status: "failed",
      activity: "Runtime exited",
    });
  });
  expect(view.result.current.runs[0].status).toBe("cancelled");
});
