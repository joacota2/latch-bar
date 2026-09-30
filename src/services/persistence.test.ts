import { beforeEach, describe, expect, it, vi } from "vitest";
import { changeState, readState, STORAGE_KEY } from "./persistence";
import { completeState } from "./persistedState";
import {
  applyAgentConfig,
  getAgentConfig,
  parseAgentConfig,
} from "./agentConfig";
import { seedAgents } from "../data/seed";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("../services/runtime", () => ({ isTauri: () => true }));
beforeEach(() => {
  localStorage.clear();
  native.invoke.mockReset();
});

describe("native persistence transport", () => {
  it("retires the legacy copy only after successful durable migration", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ runs: [] }));
    native.invoke.mockRejectedValueOnce(new Error("Disk full"));
    await expect(readState()).rejects.toThrow("Disk full");
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    native.invoke.mockResolvedValueOnce({
      revision: 1,
      epoch: "session",
      state: completeState(null),
    });
    await readState();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
  it("recalculates a conflicting mutation against the latest native snapshot", async () => {
    const state = completeState(null);
    const newer = {
      ...state,
      settings: { ...state.settings, minimumCharacters: 17 },
    };
    native.invoke
      .mockResolvedValueOnce({ revision: 1, epoch: "session", state })
      .mockResolvedValueOnce({
        accepted: false,
        snapshot: { revision: 2, epoch: "session", state: newer },
      })
      .mockResolvedValueOnce({ revision: 2, epoch: "session", state: newer })
      .mockImplementationOnce(async (_command, args) => ({
        accepted: true,
        snapshot: { revision: 3, epoch: "session", state: args.state },
      }));
    const saved = await changeState(
      (current) => ({ ...current, agents: [] }),
      "session",
    );
    expect(saved?.state.agents).toEqual([]);
    expect(saved?.state.settings.minimumCharacters).toBe(17);
  });
  it("does not submit callbacks from before a native reset", async () => {
    native.invoke.mockResolvedValueOnce({
      revision: 4,
      epoch: "new-session",
      state: completeState(null),
    });
    expect(await changeState((state) => state, "old-session")).toBeNull();
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });
});

it("GAP-10 importing omitted optional fields clears the previous workspace and profiles", () => {
  const old = {
    ...seedAgents[0],
    fixedWorkspacePath: "/private",
    codexProfile: "old",
    permissionProfile: "old-permissions",
  };
  const config = getAgentConfig(seedAgents[0]);
  delete config.fixedWorkspacePath;
  delete config.codexProfile;
  delete config.permissionProfile;
  const imported = applyAgentConfig(
    old,
    parseAgentConfig(JSON.stringify(config)),
  );
  expect(imported.fixedWorkspacePath).toBeUndefined();
  expect(imported.codexProfile).toBeUndefined();
  expect(imported.permissionProfile).toBeUndefined();
  expect(imported.id).toBe(old.id);
});
