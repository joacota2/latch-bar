import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { LatchProvider, useLatch } from "./LatchStore";
import { TransientResultProvider } from "./TransientResultStore";
import { RunsPage } from "../pages/RunsPage";
import { seedSettings } from "../data/seed";
import type { TransientSnapshot } from "../services/transientResults";
const mocks = vi.hoisted(() => ({ snapshot: { revision: 0, result: null } as TransientSnapshot, listeners: new Set<(value: TransientSnapshot) => void>(), ack: vi.fn(), dismiss: vi.fn() }));
vi.mock("../services/transientResults", () => ({
  readTransientResult: async () => mocks.snapshot,
  subscribeTransientResult: async (cb: (value: TransientSnapshot) => void) => { mocks.listeners.add(cb); return () => mocks.listeners.delete(cb); },
  acknowledgeResult: mocks.ack, dismissResult: mocks.dismiss,
}));
let store: ReturnType<typeof useLatch>;
function Harness() { store = useLatch(); return <RunsPage />; }
const view = () => render(<LatchProvider><TransientResultProvider><Harness /></TransientResultProvider></LatchProvider>);
afterEach(() => { cleanup(); localStorage.clear(); mocks.listeners.clear(); vi.clearAllMocks(); });
it("shows a memory-only answer after remount, keeps it out of history, and clears it on reset", async () => {
  localStorage.setItem("latch-bar-state-v1", JSON.stringify({ settings: { ...seedSettings, storeHistory: false } }));
  const run = { id: "run", agentId: "agent", agentName: "Agent", agentIcon: "A", sourceApplication: "Editor", sourceIcon: "E", status: "completed" as const, finalResponse: "Memory answer", model: "default", sandbox: "read-only" as const, activity: "Done", startedAt: "now" };
  mocks.snapshot = { revision: 1, result: { id: "handoff", epoch: "legacy", run, persisted: false, acknowledged: false } };
  mocks.ack.mockImplementation(async () => { mocks.snapshot = { revision: 2, result: { ...mocks.snapshot.result!, acknowledged: true } }; mocks.listeners.forEach((listener) => listener(mocks.snapshot)); });
  mocks.dismiss.mockResolvedValue(undefined);
  const mounted = view();
  await screen.findByText("Memory answer");
  await waitFor(() => expect(mocks.ack).toHaveBeenCalled());
  expect(screen.getByText("Temporary result — not saved to history")).toBeInTheDocument();
  mounted.unmount(); view(); await screen.findByText("Memory answer");
  await act(async () => { await store.updateSettings({ storeHistory: true }); });
  expect(store.runs).toEqual([]); expect(localStorage.getItem("latch-bar-state-v1")).not.toContain("Memory answer");
  await userEvent.click(screen.getByRole("button", { name: "Close run details" })); expect(mocks.dismiss).toHaveBeenCalled();
  await act(async () => { await store.clearData(); }); expect(screen.queryByText("Memory answer")).not.toBeInTheDocument();
});
